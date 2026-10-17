'use strict';

const Homey = require('homey');
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
 * Main application class for the Homey Wear OS Companion app.
 *
 * This app acts as an OAuth2 relay and dashboard provider between the HomeyWatch
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
   * Diagnostic log manager instance.
   *
   * @private
   * @type {LogManager|null}
   */
  _logManager = null;

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

    this.log(`[${TAG}:onInit] Homey Wear OS Companion App initialized.`);

    const isDebug = this.isDebugLoggingEnabled();
    this.log(`[${TAG}:onInit] Debug logging is ${isDebug ? 'ENABLED' : 'DISABLED'}.`);

    this.homey.settings.on('set', async (key) => {
      if (key === 'debug_logging_enabled') {
        const state = this.isDebugLoggingEnabled();
        if (this._logManager) {
          await this._logManager.setDebugEnabled(state);
        }
        this.log(`[${TAG}:onInit] Debug logging state changed: ${state ? 'ENABLED' : 'DISABLED'}`);
      }
    });
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
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('Missing or invalid sessionId.');
    }

    this._destroySession(sessionId);

    this.log(`[${TAG}:startAuthSession] Creating OAuth2 callback for session ${sessionId.substring(0, 8)}...`);

    const clientId = Homey.env.CLIENT_ID;
    const scopes = [
      'homey.zone.readonly',
      'homey.device.readonly',
      'homey.device.control',
      'homey.flow.readonly',
      'homey.flow.start',
      'homey.user.readonly',
      'homey.user.self',
      'homey.app.readonly',
    ].join(' ');

    const baseAuthUrl = `https://api.athom.com/oauth2/authorise`
      + `?response_type=code`
      + `&client_id=${encodeURIComponent(clientId)}`
      + `&redirect_uri=https://callback.athom.com/oauth2/callback/`
      + `&scope=${encodeURIComponent(scopes)}`;

    return new Promise((resolve, reject) => {
      this.homey.cloud.createOAuth2Callback(baseAuthUrl)
        .then((oauthCallback) => {
          oauthCallback.on('url', (authUrl) => {
            this.log(`[${TAG}:startAuthSession] Auth URL generated for session ${sessionId.substring(0, 8)}...`);

            const timer = setTimeout(() => {
              this.log(`[${TAG}:startAuthSession] Session ${sessionId.substring(0, 8)}... expired.`);
              this._sessions.delete(sessionId);
            }, SESSION_TTL_MS);

            this._sessions.set(sessionId, {
              authUrl,
              status: 'pending',
              token: null,
              timer,
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
   * Refreshes the hub session token using the stored refresh token.
   *
   * @public
   * @param {string} athomRefreshToken - The Athom OAuth2 refresh token.
   * @returns {Promise<{session_token: string, athom_refresh_token: string}>}
   * @throws {Error} If token refresh fails.
   */
  async refreshAuthSession(athomRefreshToken) {
    if (!athomRefreshToken || typeof athomRefreshToken !== 'string') {
      throw new Error('Missing or invalid athom_refresh_token.');
    }

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
      this.error(`[${TAG}:refreshAuthSession] Token refresh failed HTTP ${response.status}:`, text);
      throw new Error(`Token refresh failed with HTTP ${response.status}`);
    }

    const token = await response.json();
    this.log(`[${TAG}:refreshAuthSession] Token successfully refreshed from Athom Cloud.`);

    const sessionToken = await this.homey.api.getOwnerApiToken();
    return {
      session_token: sessionToken,
      athom_refresh_token: token.refresh_token,
    };
  }

  /**
   * Returns whether diagnostic debug logging is enabled.
   *
   * @public
   * @returns {boolean}
   */
  isDebugLoggingEnabled() {
    return this.homey.settings.get('debug_logging_enabled') === true;
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

      let userResponse = null;
      try {
        const uRes = await fetch('https://api.athom.com/user/me', {
          headers: { Authorization: `Bearer ${token.access_token}` }
        });
        if (uRes.ok) userResponse = await uRes.json();
      } catch (uErr) {
        this.error(`[${TAG}:_exchangeCode] Failed to fetch user profile:`, uErr.message);
      }

      let sessionToken = null;
      let homeyId = null;
      let homeyApiUrl = null;
      let localHomeyName = 'Homey';

      try {
        sessionToken = await this.homey.api.getOwnerApiToken();
        homeyId = await this.homey.cloud.getHomeyId();
        homeyApiUrl = `https://${homeyId}.connect.athom.com/api/`;

        try {
          const nameRes = await fetch(`${homeyApiUrl}manager/system/name`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
          });
          if (nameRes.ok) {
            const nameData = await nameRes.json();
            if (typeof nameData === 'string' && nameData) {
              localHomeyName = nameData;
            } else if (nameData && nameData.name) {
              localHomeyName = nameData.name;
            }
          }
        } catch (nameErr) {
          this.error(`[${TAG}:_exchangeCode] Failed to fetch system name:`, nameErr.message);
        }
      } catch (hubErr) {
        this.error(`[${TAG}:_exchangeCode] Failed to obtain owner API token:`, hubErr.message);
      }

      session.status = 'complete';
      session.token = {
        session_token: sessionToken,
        homey_id: homeyId,
        homey_name: localHomeyName,
        homey_api_url: homeyApiUrl,
        athom_refresh_token: token.refresh_token,
        location: null,
        user: userResponse ? {
          id: userResponse.id || userResponse._id || userResponse.athomId || 'unknown',
          name: userResponse.name || 'Homey User',
          email: userResponse.email || null,
        } : null,
      };

      this.log(`[${TAG}:_exchangeCode] Session ${sessionId.substring(0, 8)}... marked complete.`);
    } catch (err) {
      this.error(`[${TAG}:_exchangeCode] Token exchange error:`, err.message);
      session.status = 'error';
    }
  }

  /**
   * Destroys an active session and clears its timer.
   *
   * @private
   * @param {string} sessionId - The session identifier to remove.
   */
  _destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      if (session.timer) clearTimeout(session.timer);
      this._sessions.delete(sessionId);
    }
  }
}

module.exports = HomeyWearOsCompanionApp;
