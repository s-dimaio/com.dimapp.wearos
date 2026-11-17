'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const LogManager = require('./lib/LogManager');

/** @constant {string} TAG - Log tag used in all messages emitted by this class. */
const TAG = 'HomeyWearOsCompanionApp';

/**
 * @constant {number} SESSION_TTL_MS
 * How long an auth session is kept alive before being considered expired, in milliseconds.
 */
const SESSION_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * @constant {string} ATHOM_TOKEN_URL
 * Athom Cloud OAuth2 token endpoint used to exchange the authorization code for tokens.
 */
const ATHOM_TOKEN_URL = 'https://api.athom.com/oauth2/token';

/**
 * @constant {number} MAX_PENDING_SESSIONS
 * Maximum number of concurrent pending authentication sessions kept in memory.
 */
const MAX_PENDING_SESSIONS = 3;

/**
 * @constant {number} RATE_LIMIT_AUTH_START_MAX
 * Maximum allowed invocations of startAuth within the sliding window.
 */
const RATE_LIMIT_AUTH_START_MAX = 5;

/**
 * @constant {number} RATE_LIMIT_AUTH_START_WINDOW_MS
 * Duration of the sliding rate limiting window for startAuth (5 minutes in milliseconds).
 */
const RATE_LIMIT_AUTH_START_WINDOW_MS = 5 * 60 * 1000;

/**
 * @constant {number} RATE_LIMIT_AUTH_REFRESH_MAX
 * Maximum allowed invocations of refreshAuth within the sliding window.
 */
const RATE_LIMIT_AUTH_REFRESH_MAX = 10;

/**
 * @constant {number} RATE_LIMIT_AUTH_REFRESH_WINDOW_MS
 * Duration of the sliding rate limiting window for refreshAuth (5 minutes in milliseconds).
 */
const RATE_LIMIT_AUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Main application class for the Homey Wear OS by Google app.
 *
 * This app acts as an OAuth2 relay and dashboard provider between the Homey
 * Wear OS smartwatch application and the Athom Cloud. It exposes public HTTP API endpoints
 * that the smartwatch uses to bootstrap the OAuth2 Authorization Code flow:
 *
 *  - `POST /auth/start`   -> Creates an auth session via `createOAuth2Callback` and
 *                            returns the Athom authorization URL.
 *  - `GET  /auth/poll`    -> Returns the session status. When authorized on the user's phone,
 *                            tokens and hub info are returned and the session is cleared.
 *  - `POST /auth/refresh` -> Silent token rotation endpoint for expired sessions.
 *
 * @extends {Homey.App}
 */
class HomeyWearOsCompanionApp extends Homey.App {

  /**
   * Map of active auth sessions keyed by sessionId.
   *
   * @private
   * @type {Map<string, object>}
   */
  _sessions = new Map();

  /**
   * Map of sliding window timestamps for rate limiting keyed by action name.
   *
   * @private
   * @type {Map<string, number[]>}
   */
  _rateLimits = new Map();

  /**
   * Diagnostic log manager instance.
   *
   * @private
   * @type {LogManager|null}
   */
  _logManager = null;

  /**
   * Internal guard preventing recursive logging during log mirroring.
   *
   * @private
   * @type {boolean}
   */
  _isLoggingInternal = false;

  /**
   * Set of SHA-256 hashes of authorized session tokens.
   *
   * @private
   * @type {Set<string>}
   */
  _authorizedTokenHashes = new Set();

  /**
   * Bound listener reference for `this.homey.settings.on('set', ...)`, kept for cleanup in `onUninit`.
   *
   * @private
   * @type {Function|null}
   */
  _onSettingsSetListener = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Called by Homey when the application starts.
   *
   * @public
   * @returns {Promise<void>}
   */
  async onInit() {
    this._logManager = new LogManager(this);
    await this._logManager.init();

    this.log(`[${TAG}:onInit] Homey Wear OS by Google App initialized.`);

    const isDebug = this.isDebugLoggingEnabled();
    this.log(`[${TAG}:onInit] Debug logging is ${isDebug ? 'ENABLED' : 'DISABLED'}.`);
    this.log(`[${TAG}:onInit] Security hardening active: max_pending_sessions=${MAX_PENDING_SESSIONS}, rate_limit_start=${RATE_LIMIT_AUTH_START_MAX}/5m, rate_limit_refresh=${RATE_LIMIT_AUTH_REFRESH_MAX}/5m, rbac_verification=ENABLED.`);

    const savedHashes = this.homey.settings.get('authorized_token_hashes') || [];
    this._authorizedTokenHashes = new Set(Array.isArray(savedHashes) ? savedHashes : []);
    this.log(`[${TAG}:onInit] Loaded ${this._authorizedTokenHashes.size} authorized token hash(es).`);

    // Prune any deleted devices from Wear OS quick actions settings on startup
    await this.pruneDeletedDevices().catch((err) => {
      this.error(`[${TAG}:onInit] Failed to prune deleted devices on startup:`, err.message);
    });

    this._onSettingsSetListener = async (key) => {
      if (key === 'debug_logging_enabled') {
        const state = this.isDebugLoggingEnabled();
        if (this._logManager) {
          await this._logManager.setDebugEnabled(state);
        }
        this.log(`[${TAG}:onInit] Debug logging state changed: ${state ? 'ENABLED' : 'DISABLED'}`);
      }
    };
    this.homey.settings.on('set', this._onSettingsSetListener);
  }

  /**
   * Called by Homey when the application is stopped or restarted.
   * Cleans up all active authentication session timers, OAuth2 callback listeners,
   * rate limit records, and settings event listeners to prevent resource leaks.
   *
   * @public
   * @returns {Promise<void>}
   * @example
   * await app.onUninit();
   */
  async onUninit() {
    this.log(`[${TAG}:onUninit] Cleaning up application resources...`);

    for (const sessionId of Array.from(this._sessions.keys())) {
      this._destroySession(sessionId);
    }
    this._sessions.clear();
    this._rateLimits.clear();

    if (this._onSettingsSetListener && this.homey?.settings && typeof this.homey.settings.removeListener === 'function') {
      this.homey.settings.removeListener('set', this._onSettingsSetListener);
      this._onSettingsSetListener = null;
    }

    this.log(`[${TAG}:onUninit] Application cleanup complete.`);
  }

  // ── Public Methods (called from api.js) ────────────────────────────────────

  /**
   * Creates a new OAuth2 auth session for a given sessionId.
   *
   * Internally calls `this.homey.cloud.createOAuth2Callback(authorizationUrl)`.
   *
   * @public
   * @param {string} sessionId - A 64-character hex string generated with SecureRandom by the watch.
   * @returns {Promise<{authUrl: string}>} The authorization URL to display or launch on phone.
   * @throws {Error} If sessionId is missing or if callback creation fails.
   * @example
   * const { authUrl } = await homey.app.startAuthSession('a1b2c3...');
   */
  async startAuthSession(sessionId) {
    // 1. Enforce sliding window rate limit (max 5 requests per 5 minutes)
    this._checkRateLimit('auth_start', RATE_LIMIT_AUTH_START_MAX, RATE_LIMIT_AUTH_START_WINDOW_MS);

    if (!sessionId || typeof sessionId !== 'string') {
      throw Object.assign(new Error('Missing or invalid sessionId.'), { statusCode: 400 });
    }

    // 2. Invalidate any pre-existing session for this ID
    this._destroySession(sessionId);

    // 3. Enforce memory pool cap: prune oldest pending session if pool is full
    if (this._sessions.size >= MAX_PENDING_SESSIONS) {
      const oldestSessionId = this._sessions.keys().next().value;
      if (oldestSessionId) {
        this.log(`[${TAG}:startAuthSession] Session pool cap reached (${MAX_PENDING_SESSIONS}). Pruning oldest session ${oldestSessionId.substring(0, 8)}...`);
        this._destroySession(oldestSessionId);
      }
    }

    this.log(`[${TAG}:startAuthSession] Creating OAuth2 callback for session ${sessionId.substring(0, 8)}... (active pool: ${this._sessions.size}/${MAX_PENDING_SESSIONS})`);

    const clientId = Homey.env.CLIENT_ID;

    // The base authorization URL
    // createOAuth2Callback requires explicitly appending the redirect_uri configured in the Dev Portal.
    // By omitting the scope parameter entirely, Athom Cloud automatically grants all client scopes configured
    // in the Developer Portal, critically including 'account.homeys.readonly' which prompts the user to select
    // the target Homey and binds 'resource.homey.<id>' to the issued tokens.
    const baseAuthUrl = `https://api.athom.com/oauth2/authorise`
      + `?response_type=code`
      + `&client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=https://callback.athom.com/oauth2/callback/`;

    return new Promise((resolve, reject) => {
      this.homey.cloud.createOAuth2Callback(baseAuthUrl)
        .then((oauthCallback) => {
          oauthCallback.on('url', (authUrl) => {
            this.log(`[${TAG}:startAuthSession] Auth URL generated for session ${sessionId.substring(0, 8)}...`);

            const timer = setTimeout(() => {
              this.log(`[${TAG}:startAuthSession] Session ${sessionId.substring(0, 8)}... expired.`);
              this._destroySession(sessionId);
            }, SESSION_TTL_MS);

            this._sessions.set(sessionId, {
              authUrl,
              status: 'pending',
              token: null,
              timer,
              oauthCallback,
            });

            resolve({ authUrl });
          });

          oauthCallback.on('code', async (code) => {
            this.log(`[${TAG}:startAuthSession] Authorization code received for session ${sessionId.substring(0, 8)}...`);
            await this._exchangeCode(sessionId, code);
          });
        })
        .catch((err) => {
          this.error(`[${TAG}:startAuthSession] Failed to create OAuth2 callback:`, err.message);
          this._destroySession(sessionId);
          reject(err);
        });
    });
  }

  /**
   * Returns the current status of an auth session.
   *
   * @public
   * @param {string} sessionId - The session identifier.
   * @returns {{ status: 'pending'|'complete'|'expired'|'error', token?: object }}
   * @example
   * const result = homey.app.pollAuthSession('a1b2c3...');
   */
  pollAuthSession(sessionId) {
    const session = this._sessions.get(sessionId);

    if (!session) {
      return { status: 'expired' };
    }

    if (session.status === 'complete') {
      this._destroySession(sessionId);
      this.log(`[${TAG}:pollAuthSession] Token delivered and session ${sessionId.substring(0, 8)}... deleted.`);
      return { status: 'complete', token: session.token };
    }

    return { status: session.status };
  }

  /**
   * Validates whether a given session token is authorized to access protected companion endpoints.
   *
   * Validation sequence:
   * 1. Checks if the token matches the Homey Pro local Owner API token.
   * 2. Checks if the SHA-256 hash exists in the in-memory authorized token hash set.
   * 3. Fallback for pre-existing client sessions: Validates the token directly against the local
   *    Homey Pro gateway (`GET /api/manager/devices/device`). If authorized (HTTP 200), caches the
   *    hash for subsequent O(1) lookups.
   *
   * @public
   * @async
   * @param {string} token - The raw session token to validate (mandatory).
   * @returns {Promise<boolean>} True if the token is valid and authorized, false otherwise.
   * @example
   * const isAuthorized = await homey.app.isValidSessionToken(bearerToken);
   */
  async isValidSessionToken(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return false;
    }

    const cleanToken = token.trim();

    // 1. Check Owner API Token
    try {
      const ownerToken = await this.homey.api.getOwnerApiToken();
      if (ownerToken && cleanToken === ownerToken) {
        return true;
      }
    } catch (err) {
      // Ignore owner token retrieval failure
    }

    // 2. Check cached SHA-256 hashes
    const hash = crypto.createHash('sha256').update(cleanToken).digest('hex');
    if (this._authorizedTokenHashes && this._authorizedTokenHashes.has(hash)) {
      return true;
    }

    // 3. Fallback verification against local Homey gateway for pre-existing sessions
    try {
      const localUrl = await this.homey.api.getLocalUrl();
      const verifyRes = await fetch(`${localUrl}/api/manager/devices/device`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cleanToken}` },
      });

      if (verifyRes.ok) {
        this.log(`[${TAG}:isValidSessionToken] Token validated successfully against local gateway. Caching hash...`);
        this._saveAuthorizedToken(cleanToken);
        return true;
      }
    } catch (fetchErr) {
      this.error(`[${TAG}:isValidSessionToken] Gateway token verification error:`, fetchErr.message || fetchErr);
    }

    return false;
  }

  /**
   * Enforces session token authorization for protected HTTP API endpoints.
   *
   * Extracts the token from HTTP headers ('Authorization: Bearer <token>'), query parameters
   * ('?token=<token>'), or JSON request body ('{ "token": "<token>" }').
   * Rejects unauthenticated callers with an HTTP 401 Unauthorized error.
   *
   * @public
   * @async
   * @param {object} [args] - Request arguments provided by Homey Web API.
   * @param {object} [args.headers] - Request HTTP headers.
   * @param {object} [args.query] - Request query parameters.
   * @param {object} [args.body] - Request body parameters.
   * @returns {Promise<void>} Resolves if authorized; throws an HTTP 401 Error otherwise.
   * @throws {Error} If token is missing, invalid, or unauthorized (HTTP 401).
   * @example
   * await homey.app.requireValidSessionToken(args);
   */
  async requireValidSessionToken({ headers, query, body } = {}) {
    let token = null;

    // 1. Extract from Authorization header
    const authHeader = headers?.authorization || headers?.Authorization;
    if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      token = match ? match[1].trim() : authHeader.trim();
    }

    // 2. Extract from query parameters
    if (!token && query && typeof query.token === 'string' && query.token.trim().length > 0) {
      token = query.token.trim();
    }

    // 3. Extract from body parameters
    if (!token && body && typeof body.token === 'string' && body.token.trim().length > 0) {
      token = body.token.trim();
    }

    if (!token) {
      const queryKeys = query ? Object.keys(query).join(', ') : 'none';
      const bodyKeys = body ? Object.keys(body).join(', ') : 'none';
      this.error(`[${TAG}:requireValidSessionToken] Security rejection: Missing authorization token (queryKeys=[${queryKeys}], bodyKeys=[${bodyKeys}]).`);
      throw Object.assign(new Error('Unauthorized: Missing authorization token.'), { statusCode: 401 });
    }

    const isValid = await this.isValidSessionToken(token);
    if (!isValid) {
      this.error(`[${TAG}:requireValidSessionToken] Security rejection: Invalid or unauthorized token.`);
      throw Object.assign(new Error('Unauthorized: Invalid or expired session token.'), { statusCode: 401 });
    }
  }

  /**
   * Refreshes the OAuth access token using the Athom Cloud OAuth2 refresh_token.
   *
   * Enforces sliding window rate limiting (max 10 requests per 5 minutes).
   * Verifies the token by exchanging it with Athom Cloud. When Athom returns a new token pair,
   * re-verifies that the user still has membership access to this hub before delivering the refreshed tokens.
   *
   * @public
   * @param {string} athomRefreshToken - The Athom OAuth2 refresh token (mandatory).
   * @returns {Promise<{session_token: string, athom_refresh_token: string}>} The refreshed tokens.
   * @throws {Error} If rate limit is exceeded (HTTP 429), token is invalid/expired (HTTP 401),
   *                 user is not authorized on hub (HTTP 403), or token exchange fails.
   * @example
   * const tokens = await homey.app.refreshAuthSession('eyJhbGciOi...');
   */
  async refreshAuthSession(athomRefreshToken) {
    // 1. Enforce sliding window rate limit (max 10 requests per 5 minutes)
    this._checkRateLimit('auth_refresh', RATE_LIMIT_AUTH_REFRESH_MAX, RATE_LIMIT_AUTH_REFRESH_WINDOW_MS);

    if (!athomRefreshToken || typeof athomRefreshToken !== 'string') {
      throw Object.assign(new Error('Missing or invalid athom_refresh_token.'), { statusCode: 400 });
    }

    try {
      this.log(`[${TAG}:refreshAuthSession] Refreshing session with Athom Cloud...`);

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: athomRefreshToken,
        client_id: Homey.env.CLIENT_ID,
        client_secret: Homey.env.CLIENT_SECRET,
      });

      const response = await fetch(ATHOM_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        this.error(`[${TAG}:refreshAuthSession] Athom refresh_token exchange failed. Status: ${response.status}`, text);
        throw Object.assign(new Error('Invalid or expired athom_refresh_token.'), { statusCode: 401 });
      }

      // We successfully got a new OAuth token pair from Athom
      const newAthomTokens = await response.json();
      this.log(`[${TAG}:refreshAuthSession] Token successfully refreshed from Athom Cloud.`);

      // 2. Re-verify that user still has active membership permissions for this hub
      this.log(`[${TAG}:refreshAuthSession] Re-verifying hub membership permissions for refreshed token...`);
      await this._verifyHubMembership(newAthomTokens.access_token);
      this.log(`[${TAG}:refreshAuthSession] Hub membership check passed for token refresh.`);

      const homeyId = await this.homey.cloud.getHomeyId();
      this.log(`[${TAG}:refreshAuthSession] Establishing renewed bound user session token...`);

      let userSessionToken;
      try {
        userSessionToken = await this._createHomeyUserSession(newAthomTokens.access_token, homeyId);
        this.log(`[${TAG}:refreshAuthSession] Renewed bound user session token created successfully.`);
      } catch (delegationErr) {
        this.error(`[${TAG}:refreshAuthSession] Bound delegation failed during token refresh (${delegationErr.message}). Re-authentication required.`);
        const err = new Error('Companion app security has been updated. Please re-authenticate.');
        err.statusCode = 401;
        err.code = 'REAUTH_REQUIRED';
        err.reason = 'COMPANION_UPDATED';
        throw err;
      }

      return {
        session_token: userSessionToken,
        athom_refresh_token: newAthomTokens.refresh_token,
      };
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) throw err;
      this.error(`[${TAG}:refreshAuthSession] Failed to refresh auth session:`, err.message || err);
      throw Object.assign(new Error('Internal error during token refresh.'), { statusCode: 500 });
    }
  }

  /**
   * Prunes devices that no longer exist on Homey Pro from Wear OS settings.
   *
   * Cleans up deleted device IDs from `wearos_devices_ids`, as well as orphaned entries
   * from `wearos_device_capabilities` and `wearos_device_names`.
   *
   * @public
   * @async
   * @param {object|null} [existingDevicesMap=null] - Optional pre-fetched map of devices from Homey API (optional).
   * @returns {Promise<string[]>} Resolves with the sanitized array of valid device IDs.
   * @example
   * const validIds = await this.pruneDeletedDevices();
   */
  async pruneDeletedDevices(existingDevicesMap = null) {
    try {
      const savedIds = this.homey.settings.get('wearos_devices_ids') || [];
      const savedCapabilities = this.homey.settings.get('wearos_device_capabilities') || {};
      const savedNames = this.homey.settings.get('wearos_device_names') || {};

      const hasIds = Array.isArray(savedIds) && savedIds.length > 0;
      const hasCaps = savedCapabilities && typeof savedCapabilities === 'object' && !Array.isArray(savedCapabilities) && Object.keys(savedCapabilities).length > 0;
      const hasNames = savedNames && typeof savedNames === 'object' && !Array.isArray(savedNames) && Object.keys(savedNames).length > 0;

      // Skip fetching the full device registry when no quick-action settings are stored yet
      if (!hasIds && !hasCaps && !hasNames) {
        return [];
      }

      let devices = existingDevicesMap;
      if (!devices || typeof devices !== 'object') {
        const localUrl = await this.homey.api.getLocalUrl();
        const token = await this.homey.api.getOwnerApiToken();
        const response = await fetch(`${localUrl}/api/manager/devices/device`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          this.error(`[${TAG}:pruneDeletedDevices] Failed to fetch devices from local API: HTTP ${response.status}`);
          return Array.isArray(savedIds) ? savedIds : [];
        }
        devices = await response.json();
      }

      const validDeviceIds = new Set(Object.keys(devices || {}));

      const validIds = (Array.isArray(savedIds) ? savedIds : []).filter(id => validDeviceIds.has(id));
      let modified = validIds.length !== (Array.isArray(savedIds) ? savedIds.length : 0);

      const cleanedCapabilities = {};
      if (savedCapabilities && typeof savedCapabilities === 'object' && !Array.isArray(savedCapabilities)) {
        for (const [id, cap] of Object.entries(savedCapabilities)) {
          if (validDeviceIds.has(id)) {
            cleanedCapabilities[id] = cap;
          } else {
            modified = true;
          }
        }
      }

      const cleanedNames = {};
      if (savedNames && typeof savedNames === 'object' && !Array.isArray(savedNames)) {
        for (const [id, name] of Object.entries(savedNames)) {
          if (validDeviceIds.has(id)) {
            cleanedNames[id] = name;
          } else {
            modified = true;
          }
        }
      }

      if (modified) {
        this.log(`[${TAG}:pruneDeletedDevices] Pruned deleted devices from Wear OS settings: before=${Array.isArray(savedIds) ? savedIds.length : 0}, after=${validIds.length}`);
        this.homey.settings.set('wearos_devices_ids', validIds);
        this.homey.settings.set('wearos_device_capabilities', cleanedCapabilities);
        this.homey.settings.set('wearos_device_names', cleanedNames);
      }

      return validIds;
    } catch (err) {
      this.error(`[${TAG}:pruneDeletedDevices] Error during device pruning:`, err.message);
      return this.homey.settings.get('wearos_devices_ids') || [];
    }
  }

  /**
   * Returns whether diagnostic debug logging is enabled.
   *
   * @public
   * @returns {boolean}
   */
  isDebugLoggingEnabled() {
    return Boolean(this.homey?.settings?.get('debug_logging_enabled'));
  }

  /**
   * Returns the LogManager instance.
   *
   * @public
   * @returns {LogManager|null}
   */
  getLogManager() {
    return this._logManager;
  }

  /**
   * Overrides {@link Homey.App#log} to print to standard console (stdout) and mirror sanitized
   * messages to the persistent LogManager diagnostic file when debug logging is active.
   *
   * @public
   * @param {...any} args - Log messages or objects to output.
   * @returns {void}
   * @example
   * this.log('[Auth:start] Initializing pairing session');
   */
  log(...args) {
    super.log(...args);
    if (this._isLoggingInternal) return;
    if (this._logManager && this._logManager.isDebugEnabled()) {
      try {
        this._isLoggingInternal = true;
        const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
        const formatted = sanitizedArgs.map(arg => {
          if (arg === null || arg === undefined) return String(arg);
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          }
          return String(arg);
        }).join(' ');

        const match = formatted.match(/^\[([a-zA-Z0-9_\-:]+)\]\s*(.*)$/s);
        const tag = match ? match[1] : TAG;
        const message = match ? match[2] : formatted;

        this._logManager.writeLog('INFO', tag, message);
      } catch (err) {
        // Ignored to prevent runtime interruption during logging
      } finally {
        this._isLoggingInternal = false;
      }
    }
  }

  /**
   * Overrides {@link Homey.App#error} to print to standard error console (stderr) and mirror sanitized
   * error messages to the persistent LogManager diagnostic file.
   *
   * @public
   * @param {...any} args - Error messages, Error instances, or objects to output.
   * @returns {void}
   * @example
   * this.error('[Auth:exchange] Code exchange failed:', error.message);
   */
  error(...args) {
    super.error(...args);
    if (this._isLoggingInternal) return;
    if (this._logManager) {
      try {
        this._isLoggingInternal = true;
        const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
        const formatted = sanitizedArgs.map(arg => {
          if (arg === null || arg === undefined) return String(arg);
          if (arg instanceof Error) {
            return `${arg.message || ''}${arg.stack ? `\n${arg.stack}` : ''}`;
          }
          if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch (e) { return String(arg); }
          }
          return String(arg);
        }).join(' ');

        const match = formatted.match(/^\[([a-zA-Z0-9_\-:]+)\]\s*(.*)$/s);
        const tag = match ? match[1] : TAG;
        const message = match ? match[2] : formatted;

        this._logManager.writeLog('ERROR', tag, message);
      } catch (err) {
        // Ignored to prevent runtime interruption during logging
      } finally {
        this._isLoggingInternal = false;
      }
    }
  }

  /**
   * Emits a structured debug log message if debug logging is enabled in settings.
   * Adheres strictly to the logging system guidelines:
   * - Format: [ClassName:methodName] message
   * - English language only
   * - Automatic sanitization of sensitive PII, credentials, and coordinates
   * - Prohibition of emoticons and non-textual symbols
   *
   * @public
   * @param {string} tag - Context identifier, e.g. 'ClassName:methodName'.
   * @param {...any} args - Log message or objects to output.
   * @returns {void}
   * @example
   * this.debugLog('api:getDevices', 'Filtering device:', device.name);
   */
  debugLog(tag, ...args) {
    if (!this.isDebugLoggingEnabled()) return;
    const sanitizedArgs = args.map(arg => this._sanitizeLogPayload(arg));
    super.log(`[DEBUG] [${tag}]`, ...sanitizedArgs);
    if (this._logManager) {
      const formattedMessage = sanitizedArgs.map(arg => {
        if (arg === null || arg === undefined) return String(arg);
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      this._logManager.writeLog('DEBUG', tag, formattedMessage);
    }
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Exchanges authorization code for access and refresh tokens.
   *
   * @private
   * @param {string} sessionId - The session identifier.
   * @param {string} code - The authorization code.
   * @returns {Promise<void>}
   */
  async _exchangeCode(sessionId, code) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      this.error(`[${TAG}:_exchangeCode] Session ${sessionId.substring(0, 8)}... not found during code exchange.`);
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: Homey.env.CLIENT_ID,
        client_secret: Homey.env.CLIENT_SECRET,
        redirect_uri: 'https://callback.athom.com/oauth2/callback/',
      });

      const response = await fetch(ATHOM_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token endpoint responded with HTTP ${response.status}: ${text}`);
      }

      const token = await response.json();
      this.log(`[${TAG}:_exchangeCode] Token exchange successful for session ${sessionId.substring(0, 8)}...`);

      // 1. Verify user profile and hub membership against Athom Cloud
      this.log(`[${TAG}:_exchangeCode] Verifying hub membership with Athom Cloud for session ${sessionId.substring(0, 8)}...`);
      const userResponse = await this._verifyHubMembership(token.access_token);
      this.log(`[${TAG}:_exchangeCode] Hub membership check passed for session ${sessionId.substring(0, 8)}...`);

      const homeyId = await this.homey.cloud.getHomeyId();
      const homeyApiUrl = `https://${homeyId}.connect.athom.com/api/`;

      // 2. Establish scoped User Session Token and resolve local hub name in parallel
      this.log(`[${TAG}:_exchangeCode] Establishing bound user session token and resolving hub name for session ${sessionId.substring(0, 8)}...`);
      const [userSessionToken, localHomeyName] = await Promise.all([
        this._createHomeyUserSession(token.access_token, homeyId),
        this._fetchLocalHubName(),
      ]);
      this.log(`[${TAG}:_exchangeCode] Bound user session token and hub info obtained for session ${sessionId.substring(0, 8)}... (Hub Name: ${localHomeyName})`);

      session.status = 'complete';
      session.token = {
        session_token: userSessionToken,
        homey_id: homeyId,
        homey_name: localHomeyName,
        homey_api_url: homeyApiUrl,
        athom_refresh_token: token.refresh_token,
        user: userResponse ? {
          id: userResponse.id || userResponse._id || userResponse.athomId || (userResponse.user && (userResponse.user.id || userResponse.user._id || userResponse.user.athomId)) || 'unknown',
          name: userResponse.name || userResponse.fullname || (userResponse.user && (userResponse.user.name || userResponse.user.fullname)) || `${userResponse.firstname || (userResponse.user && userResponse.user.firstname) || ''} ${userResponse.lastname || (userResponse.user && userResponse.user.lastname) || ''}`.trim() || 'Homey User',
          email: userResponse.email || (userResponse.user && userResponse.user.email) || null,
          role: userResponse.localRole || 'user',
        } : null,
      };

      this.log(`[${TAG}:_exchangeCode] Session ${sessionId.substring(0, 8)}... marked complete.`);
    } catch (err) {
      this.error(`[${TAG}:_exchangeCode] Token exchange error:`, err.message || err);
      session.status = 'error';
    }
  }

  /**
   * Destroys an active session, clears its timeout, and removes all EventEmitter listeners.
   *
   * @private
   * @param {string} sessionId - The session identifier to remove.
   * @returns {void}
   * @example
   * this._destroySession('a1b2c3d4...');
   */
  _destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      if (session.timer) {
        clearTimeout(session.timer);
      }
      if (session.oauthCallback && typeof session.oauthCallback.removeAllListeners === 'function') {
        try {
          session.oauthCallback.removeAllListeners();
        } catch (err) {
          this.error(`[${TAG}:_destroySession] Failed to remove listeners from oauthCallback:`, err.message || err);
        }
      }
      this._sessions.delete(sessionId);
      this.log(`[${TAG}:_destroySession] Session ${sessionId.substring(0, 8)}... destroyed and cleaned up from pool.`);
    }
  }

  /**
   * Enforces a sliding window in-memory rate limit for sensitive public operations.
   *
   * Prunes expired timestamps older than `windowMs` and verifies that the total
   * request count within the active window does not exceed `maxRequests`.
   * If the limit is exceeded, logs a security error and throws an HTTP 429 exception.
   *
   * @private
   * @param {string} actionKey - Unique key identifying the operation being rate-limited (mandatory).
   * @param {number} maxRequests - Maximum number of requests permitted within the time window (mandatory).
   * @param {number} windowMs - Duration of the sliding time window in milliseconds (mandatory).
   * @returns {void}
   * @throws {Error} If request frequency exceeds maxRequests within windowMs (HTTP 429).
   * @example
   * this._checkRateLimit('auth_start', 5, 300000);
   */
  _checkRateLimit(actionKey, maxRequests, windowMs) {
    const now = Date.now();
    const timestamps = this._rateLimits.get(actionKey) || [];
    const validTimestamps = timestamps.filter(ts => (now - ts) < windowMs);

    if (validTimestamps.length >= maxRequests) {
      this.error(`[${TAG}:_checkRateLimit] Security rejection: Rate limit exceeded for action '${actionKey}' (${validTimestamps.length}/${maxRequests} in ${windowMs}ms).`);
      throw Object.assign(new Error(`Rate limit exceeded for ${actionKey}. Please try again later.`), { statusCode: 429 });
    }

    validTimestamps.push(now);
    this._rateLimits.set(actionKey, validTimestamps);
    this.debugLog(`${TAG}:_checkRateLimit`, `Rate limit check passed for action '${actionKey}' (${validTimestamps.length}/${maxRequests} in ${windowMs}ms).`);
  }

  /**
   * Verifies that the authenticated Athom user is registered on this local Homey Pro hub
   * and holds an authorized role (`owner`, `manager`, or `user` / resident).
   *
   * Flow:
   * 1. Queries Athom Cloud (`GET https://api.athom.com/user/me`) to authenticate the Bearer token
   *    and extract the verified Athom account identifier (`userId`).
   * 2. Queries the local Homey Pro User Manager (`GET /api/manager/users/user`) using the owner token
   *    to verify that `userId` matches a registered local user's `athomId` or `id`.
   * 3. Inspects the local user's `enabled` status and `role`, explicitly rejecting disabled accounts
   *    and `guest` users with HTTP 403 Forbidden.
   *
   * @private
   * @async
   * @param {string} accessToken - The Athom Cloud OAuth2 access token (mandatory).
   * @returns {Promise<object>} The Athom user profile object enriched with `localRole`.
   * @throws {Error} If accessToken is missing (HTTP 400), user profile fetch fails (HTTP 401),
   *                 or if the user is not registered, disabled, or has a `guest` role (HTTP 403).
   * @example
   * const userProfile = await this._verifyHubMembership(token.access_token);
   */
  async _verifyHubMembership(accessToken) {
    if (!accessToken || typeof accessToken !== 'string') {
      throw Object.assign(new Error('Missing or invalid accessToken.'), { statusCode: 400 });
    }

    this.log(`[${TAG}:_verifyHubMembership] Authenticating user token with Athom Cloud...`);

    const response = await fetch('https://api.athom.com/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.error(`[${TAG}:_verifyHubMembership] Failed to fetch Athom user profile. Status: ${response.status}`, errorText);
      throw Object.assign(new Error('Failed to retrieve Athom user profile.'), { statusCode: 401 });
    }

    const userProfile = await response.json();
    const currentHomeyId = await this.homey.cloud.getHomeyId();
    const maskedHomeyId = this._maskId(currentHomeyId);

    const userId = userProfile.id
      || userProfile._id
      || userProfile.athomId
      || (userProfile.user && (userProfile.user.id || userProfile.user._id || userProfile.user.athomId))
      || null;

    if (!userId) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: Could not extract user ID from Athom profile.`);
      throw Object.assign(new Error('Invalid Athom user profile.'), { statusCode: 401 });
    }

    const maskedUserId = this._maskId(userId);

    // Query Local Homey Pro User Registry
    let usersList = [];
    try {
      const localUrl = await this.homey.api.getLocalUrl();
      const ownerToken = await this.homey.api.getOwnerApiToken();
      const usersResponse = await fetch(`${localUrl}/api/manager/users/user`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      if (!usersResponse.ok) {
        this.error(`[${TAG}:_verifyHubMembership] Local users API responded with HTTP ${usersResponse.status}.`);
        throw new Error(`Local users API failed with status ${usersResponse.status}`);
      }

      const usersData = await usersResponse.json();
      usersList = Array.isArray(usersData) ? usersData : Object.values(usersData || {});
    } catch (localErr) {
      this.error(`[${TAG}:_verifyHubMembership] Failed to query local users registry:`, localErr.message || localErr);
      throw Object.assign(new Error('Failed to verify local hub users registry.'), { statusCode: 500 });
    }

    const matchedLocalUser = usersList.find(u => u && (
      (u.athomId && u.athomId === userId) ||
      (u.id && u.id === userId) ||
      (u._id && u._id === userId)
    ));

    if (!matchedLocalUser) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: Authenticated user '${maskedUserId}' is not registered on hub '${maskedHomeyId}' (localUsersCount=${usersList.length}). Access denied.`);
      throw Object.assign(new Error('User is not authorized on this Homey hub.'), { statusCode: 403 });
    }

    const userRole = typeof matchedLocalUser.role === 'string' ? matchedLocalUser.role.toLowerCase() : 'unknown';
    const isEnabled = matchedLocalUser.enabled !== false;
    const isPresent = Boolean(matchedLocalUser.present);
    const isAsleep = Boolean(matchedLocalUser.asleep);
    const localUserKeys = Object.keys(matchedLocalUser).join(', ');

    this.log(`[${TAG}:_verifyHubMembership] Local user found on hub '${maskedHomeyId}': user='${maskedUserId}', role='${userRole}', enabled=${isEnabled}, present=${isPresent}, asleep=${isAsleep}, keys=[${localUserKeys}]`);

    if (!isEnabled) {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: User '${maskedUserId}' is disabled on hub '${maskedHomeyId}'. Access denied.`);
      throw Object.assign(new Error('User account is disabled on this Homey hub.'), { statusCode: 403 });
    }

    if (userRole === 'guest') {
      this.error(`[${TAG}:_verifyHubMembership] Security rejection: User '${maskedUserId}' has role 'guest' on hub '${maskedHomeyId}'. Guest accounts are not permitted. Access denied.`);
      throw Object.assign(new Error('Guest users are not authorized to access this Homey hub.'), { statusCode: 403 });
    }

    this.log(`[${TAG}:_verifyHubMembership] Security check passed: User '${maskedUserId}' (role='${userRole}') is authorized for hub '${maskedHomeyId}'.`);

    userProfile.localRole = userRole;
    return userProfile;
  }

  /**
   * Exchanges an Athom Cloud OAuth2 access token for a bound delegation token
   * and logs in to the local Homey Pro gateway to obtain a scoped user session token.
   *
   * Flow:
   * 1. Requests a bound delegation token from Athom Cloud:
   *    `POST https://api.athom.com/delegation/token?audience=homey&homeyId={homeyId}`
   *    Payload: `{ resource: 'resource.homey.' + homeyId }`
   * 2. Extracts the signed delegation JWT.
   * 3. Authenticates with the Homey Pro User Manager gateway:
   *    `POST {localUrl}/api/manager/users/login` (with connect.athom.com fallback)
   *    Payload: `{ token: delegationJwt, resource: 'resource.homey.' + homeyId }`
   * 4. Extracts and returns the established user session token.
   *
   * @private
   * @async
   * @param {string} accessToken - The Athom Cloud OAuth2 access token (mandatory).
   * @param {string} homeyId - The unique 24-character hex ID of this Homey Pro hub (mandatory).
   * @returns {Promise<string>} The scoped user session token.
   * @throws {Error} If delegation token issuance or gateway login fails.
   * @example
   * const userSessionToken = await this._createHomeyUserSession(token.access_token, homeyId);
   */
  async _createHomeyUserSession(accessToken, homeyId) {
    if (!accessToken || typeof accessToken !== 'string') {
      throw Object.assign(new Error('Missing or invalid accessToken.'), { statusCode: 400 });
    }
    if (!homeyId || typeof homeyId !== 'string') {
      throw Object.assign(new Error('Missing or invalid homeyId.'), { statusCode: 400 });
    }

    const maskedHomeyId = this._maskId(homeyId);

    this.log(`[${TAG}:_createHomeyUserSession] Requesting bound delegation token for hub '${maskedHomeyId}' from Athom Cloud...`);

    const delegationUrl = `https://api.athom.com/delegation/token?audience=homey&homeyId=${encodeURIComponent(homeyId)}`;
    const delegationResponse = await fetch(delegationUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ resource: `resource.homey.${homeyId}` }),
    });

    if (!delegationResponse.ok) {
      const errorText = await delegationResponse.text().catch(() => '');
      this.error(`[${TAG}:_createHomeyUserSession] Delegation token request failed with HTTP ${delegationResponse.status}:`, errorText);
      throw Object.assign(new Error(`Delegation token request failed (HTTP ${delegationResponse.status})`), { statusCode: delegationResponse.status });
    }

    const delegationData = await delegationResponse.json();
    const delegationJwt = typeof delegationData === 'string'
      ? delegationData
      : (delegationData.token || delegationData.result || delegationData);

    if (!delegationJwt || typeof delegationJwt !== 'string') {
      this.error(`[${TAG}:_createHomeyUserSession] Unexpected delegation response format.`);
      throw Object.assign(new Error('Invalid delegation token response from Athom Cloud.'), { statusCode: 502 });
    }

    this.log(`[${TAG}:_createHomeyUserSession] Bound delegation token received. Logging in to Homey Pro gateway...`);

    const loginPayload = JSON.stringify({
      token: delegationJwt,
      resource: `resource.homey.${homeyId}`,
    });

    let loginResponse = null;

    // 1. Attempt gateway login via internal loopback localUrl
    try {
      const localUrl = await this.homey.api.getLocalUrl();
      loginResponse = await fetch(`${localUrl}/api/manager/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: loginPayload,
      });
    } catch (localErr) {
      this.log(`[${TAG}:_createHomeyUserSession] Local loopback gateway login attempt failed (${localErr.message}), falling back to connect URL...`);
    }

    // 2. If loopback failed or returned error, fallback to cloud-routed connect.athom.com
    if (!loginResponse || !loginResponse.ok) {
      const fallbackUrl = `https://${homeyId}.connect.athom.com/api/manager/users/login`;
      this.log(`[${TAG}:_createHomeyUserSession] Attempting gateway login via connect URL: ${fallbackUrl}`);
      loginResponse = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: loginPayload,
      });
    }

    if (!loginResponse.ok) {
      const loginErrorText = await loginResponse.text().catch(() => '');
      this.error(`[${TAG}:_createHomeyUserSession] Homey gateway login failed with HTTP ${loginResponse.status}:`, loginErrorText);
      throw Object.assign(new Error(`Homey gateway login failed (HTTP ${loginResponse.status})`), { statusCode: loginResponse.status });
    }

    const loginData = await loginResponse.json();
    const userSessionToken = typeof loginData === 'string'
      ? loginData
      : (loginData.token || loginData.session_token || loginData);

    if (!userSessionToken || typeof userSessionToken !== 'string') {
      this.error(`[${TAG}:_createHomeyUserSession] Unexpected login response format.`);
      throw Object.assign(new Error('Invalid session token response from Homey gateway.'), { statusCode: 502 });
    }

    this.log(`[${TAG}:_createHomeyUserSession] Scoped user session token successfully established for hub '${maskedHomeyId}'.`);
    this._saveAuthorizedToken(userSessionToken);
    return userSessionToken;
  }

  /**
   * Persists the SHA-256 hash of an authorized session token in memory and settings.
   *
   * Hashes the token using SHA-256 before storage to ensure tokens are never persisted in plaintext.
   * Maintains a capped history (maximum 50 token hashes) to prevent unbounded storage growth.
   *
   * @private
   * @param {string} token - The raw session token to authorize (mandatory).
   * @returns {void}
   * @example
   * this._saveAuthorizedToken('a1b2c3d4...');
   */
  _saveAuthorizedToken(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) return;
    const hash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    if (!this._authorizedTokenHashes) {
      this._authorizedTokenHashes = new Set();
    }
    this._authorizedTokenHashes.add(hash);
    const hashArray = Array.from(this._authorizedTokenHashes).slice(-50);
    this._authorizedTokenHashes = new Set(hashArray);
    try {
      this.homey.settings.set('authorized_token_hashes', hashArray);
      this.log(`[${TAG}:_saveAuthorizedToken] Authorized token hash stored. Total cached hashes: ${this._authorizedTokenHashes.size}`);
    } catch (err) {
      this.error(`[${TAG}:_saveAuthorizedToken] Failed to save authorized token hash in settings:`, err.message || err);
    }
  }

  /**
   * Fetches the user-defined Homey hub name over the local loopback API with fallback to `'Homey'`.
   *
   * @private
   * @async
   * @returns {Promise<string>} The resolved hub display name.
   * @example
   * const hubName = await this._fetchLocalHubName();
   */
  async _fetchLocalHubName() {
    try {
      const [localUrl, ownerSessionToken] = await Promise.all([
        this.homey.api.getLocalUrl(),
        this.homey.api.getOwnerApiToken(),
      ]);
      const headers = { Authorization: `Bearer ${ownerSessionToken}` };

      const nameRes = await fetch(`${localUrl}/api/manager/system/name`, { headers });
      if (nameRes.ok) {
        const nameData = await nameRes.json();
        if (typeof nameData === 'string' && nameData.trim()) {
          return nameData.trim();
        }
        if (nameData && typeof nameData.name === 'string' && nameData.name.trim()) {
          return nameData.name.trim();
        }
        if (nameData && typeof nameData.value === 'string' && nameData.value.trim()) {
          return nameData.value.trim();
        }
      }

      const sysRes = await fetch(`${localUrl}/api/manager/system`, { headers });
      if (sysRes.ok) {
        const sysData = await sysRes.json();
        if (sysData && typeof sysData.name === 'string' && sysData.name.trim()) {
          return sysData.name.trim();
        }
      }
    } catch (err) {
      this.log(`[${TAG}:_fetchLocalHubName] Could not fetch local system name, using default: ${err.message}`);
    }
    return 'Homey';
  }

  /**
   * Masks an identifier so only its first and last 4 characters are shown in logs.
   *
   * @private
   * @param {string} id - Identifier string to mask (mandatory).
   * @returns {string} Masked identifier suitable for diagnostic logs.
   * @example
   * const safeId = this._maskId('5f9e8d7c6b5a432100001234');
   */
  _maskId(id) {
    return (typeof id === 'string' && id.length > 8)
      ? `${id.substring(0, 4)}***${id.slice(-4)}`
      : '***';
  }

  /**
   * Sanitizes a log payload by masking sensitive tokens, passwords, emails, and GPS coordinates.
   * Delegates string masking to {@link LogManager.sanitize}.
   *
   * @private
   * @param {any} payload - Data payload to sanitize.
   * @returns {any} Sanitized payload safe for logging.
   * @example
   * const safeObj = this._sanitizeLogPayload({ token: 'abc', lat: 45.1 });
   */
  _sanitizeLogPayload(payload) {
    if (payload === null || payload === undefined) return payload;
    if (payload instanceof Error) {
      const sanitizedMessage = LogManager.sanitize(payload.message || '');
      const sanitizedStack = payload.stack ? LogManager.sanitize(payload.stack) : undefined;
      const cleanError = new Error(sanitizedMessage);
      if (sanitizedStack) cleanError.stack = sanitizedStack;
      if (payload.code) cleanError.code = payload.code;
      if (payload.statusCode) cleanError.statusCode = payload.statusCode;
      return cleanError;
    }
    if (typeof payload === 'string') {
      return LogManager.sanitize(payload);
    }
    if (typeof payload === 'object') {
      try {
        const str = JSON.stringify(payload);
        const sanitizedStr = LogManager.sanitize(str);
        return JSON.parse(sanitizedStr);
      } catch (err) {
        return '[Complex Object]';
      }
    }
    return payload;
  }
}

module.exports = HomeyWearOsCompanionApp;
