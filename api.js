'use strict';

const fs = require('fs');

/** @constant {number} MAX_LOG_BACKUPS - Number of rotated log backup files. */
const MAX_LOG_BACKUPS = 2;

/**
 * API route handlers for the Homey Wear OS Companion app.
 *
 * @module api
 */

/**
 * Handles `POST /auth/start`.
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @param {object} args.body - Request body.
 * @param {string} args.body.sessionId - 64-char hex session identifier.
 * @returns {Promise<{authUrl: string}>}
 */
async function startAuth({ homey, body }) {
  const { sessionId } = body ?? {};

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 16) {
    throw Object.assign(new Error('Missing or invalid sessionId.'), { statusCode: 400 });
  }

  return homey.app.startAuthSession(sessionId);
}

/**
 * Handles `GET /auth/poll`.
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @param {object} args.query - Request query parameters.
 * @param {string} args.query.session - Session identifier.
 * @returns {{ status: string, token?: object }}
 */
function pollAuth({ homey, query }) {
  const sessionId = query?.session;

  if (!sessionId || typeof sessionId !== 'string') {
    throw Object.assign(new Error('Missing required query parameter: session.'), { statusCode: 400 });
  }

  return homey.app.pollAuthSession(sessionId);
}

/**
 * Handles `POST /auth/refresh`.
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @param {object} args.body - Request body.
 * @returns {Promise<{session_token: string, athom_refresh_token: string}>}
 */
async function refreshAuth({ homey, body }) {
  const athomRefreshToken = body?.athom_refresh_token;

  if (!athomRefreshToken || typeof athomRefreshToken !== 'string') {
    throw Object.assign(new Error('Missing or invalid athom_refresh_token.'), { statusCode: 400 });
  }

  return homey.app.refreshAuthSession(athomRefreshToken);
}

/**
 * Handles `GET /dashboards`.
 *
 * Returns a virtual dashboard containing the quick access devices selected
 * by the user in the Wear OS settings page (stored under `wearos_devices_ids`).
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @returns {Promise<object>}
 */
async function getDashboards({ homey }) {
  homey.app.log('[api:getDashboards] Wear OS dashboard request received');

  const selectedIds = homey.settings.get('wearos_devices_ids') || [];
  const configuredCapabilities = homey.settings.get('wearos_device_capabilities') || {};
  const configuredNames = homey.settings.get('wearos_device_names') || {};

  if (selectedIds.length === 0) {
    homey.app.log('[api:getDashboards] No devices selected in settings, returning empty virtual dashboard');
    return {};
  }

  // Cap at 4 devices for 2x2 Wear OS Tile
  const finalIds = selectedIds.slice(0, 4);

  const virtualDashboardId = 'virtual-wearos-home';
  const dashboard = {
    id: virtualDashboardId,
    columns: [
      {
        widgets: [
          {
            type: 'devices_custom',
            data: {
              deviceIds: finalIds,
              capabilities: configuredCapabilities,
              customNames: configuredNames,
            },
          },
        ],
      },
    ],
  };

  const response = {};
  response[virtualDashboardId] = dashboard;

  homey.app.log(`[api:getDashboards] Returning 1 virtual dashboard with ${selectedIds.length} devices.`);
  return response;
}

/**
 * Handles `GET /devices`.
 * Helper for the settings page to list controllable devices with their available Quick Actions.
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @returns {Promise<object>}
 */
async function getDevices({ homey }) {
  homey.app.log('[api:getDevices] Proxy request received');

  const localUrl = await homey.api.getLocalUrl();
  const token = await homey.api.getOwnerApiToken();

  const response = await fetch(`${localUrl}/api/manager/devices/device`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'no body');
    homey.app.error(`[api:getDevices] Proxy failed with status: ${response.status}. Details: ${errorBody}`);
    throw new Error(`Local API fetch failed with status: ${response.status}`);
  }

  const devices = await response.json();
  const configuredCapabilities = homey.settings.get('wearos_device_capabilities') || {};

  const excludedIds = new Set();
  for (const device of Object.values(devices)) {
    if (device.settings && Array.isArray(device.settings.deviceIds)) {
      for (const childId of device.settings.deviceIds) {
        excludedIds.add(childId);
      }
    }
  }

  const filtered = {};
  for (const [id, device] of Object.entries(devices)) {
    if (device.hidden === true || excludedIds.has(id)) {
      continue;
    }

    const effectiveClass = device.virtualClass || device.class;
    const isLight = effectiveClass === 'light';
    const isDoor = effectiveClass === 'lock' || effectiveClass === 'garagedoor' || effectiveClass === 'doorbell';
    const isThermostat = effectiveClass === 'thermostat';

    if (isLight || isDoor || isThermostat) {
      const quickActions = _extractQuickActions(device, homey);
      const defaultQa = quickActions.length > 0 ? quickActions[0].id : null;
      const selectedQa = configuredCapabilities[id] || defaultQa;
      const zoneSortIndex = typeof device.zoneSortIndex === 'number'
        ? device.zoneSortIndex
        : (typeof device.sortIndex === 'number' ? device.sortIndex : null);

      filtered[id] = {
        id: device.id,
        name: device.name,
        class: effectiveClass,
        zone: device.zone,
        zoneSortIndex,
        quickActions,
        selectedQuickAction: selectedQa,
      };
    }
  }

  homey.app.log(`[api:getDevices] Returned ${Object.keys(filtered).length} filtered devices.`);
  return filtered;
}

/**
 * Handles `GET /zones`.
 * Helper for the settings page.
 *
 * @public
 * @param {object} args
 * @param {import('homey').Homey} args.homey - Homey instance.
 * @returns {Promise<object>}
 */
async function getZones({ homey }) {
  homey.app.log('[api:getZones] Proxy request received');

  const localUrl = await homey.api.getLocalUrl();
  const token = await homey.api.getOwnerApiToken();

  const response = await fetch(`${localUrl}/api/manager/zones/zone`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'no body');
    homey.app.error(`[api:getZones] Proxy failed with status: ${response.status}. Details: ${errorBody}`);
    throw new Error(`Local API fetch failed with status: ${response.status}`);
  }

  return response.json();
}


// ── Log Management Endpoints ──────────────────────────────────────────────

/**
 * Formats bytes into human-readable string.
 *
 * @private
 * @param {number} bytes - Number of bytes.
 * @returns {string}
 */
function _formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Returns standardized log file name based on rotation index.
 *
 * @private
 * @param {number} index - Rotation index.
 * @returns {string}
 */
function _getLogFileName(index) {
  return index === 0 ? 'app_debug.log' : `app_debug.${index}.log`;
}

/**
 * Extracts candidate Quick Action capabilities for a given device.
 *
 * @private
 * @param {object} device - Homey device object.
 * @param {import('homey').Homey} [homey=null] - Homey instance for diagnostic logging.
 * @returns {Array<{id: string, title: string, type: string}>}
 */
function _extractQuickActions(device, homey = null) {
  const capsObj = device.capabilitiesObj || {};
  const capsList = device.capabilities || Object.keys(capsObj);
  const actions = [];

  for (const capId of capsList) {
    const cap = capsObj[capId] || {};

    // Skip read-only sensors, meters, and alarms
    if (
      cap.setable === false ||
      capId.startsWith('measure_') ||
      capId.startsWith('meter_') ||
      capId.startsWith('alarm_')
    ) {
      continue;
    }

    // 1. Explicitly designated quick actions by Homey SDK / Device UI
    const isExplicitQuickAction =
      cap.uiQuickAction === true ||
      cap.options?.uiQuickAction === true ||
      device.ui?.quickAction === capId ||
      (Array.isArray(device.ui?.quickActions) && device.ui.quickActions.includes(capId));

    // 2. Actionable capabilities on device tile (momentary buttons or toggles)
    const isActionableComponent =
      cap.type === 'boolean' ||
      cap.type === 'button' ||
      cap.uiComponent === 'button' ||
      cap.uiComponent === 'toggle' ||
      cap.options?.uiComponent === 'button' ||
      cap.options?.uiComponent === 'toggle' ||
      capId === 'button' ||
      capId.startsWith('button.');

    if (isExplicitQuickAction || isActionableComponent) {
      const isButton =
        cap.type === 'button' ||
        cap.uiComponent === 'button' ||
        cap.options?.uiComponent === 'button' ||
        capId === 'button' ||
        capId.startsWith('button.');

      // Determine human-readable title
      const titleObj = cap.title || cap.options?.title || device.capabilitiesOptions?.[capId]?.title;
      let title = '';
      if (typeof titleObj === 'object' && titleObj !== null) {
        title = titleObj.it || titleObj.en || Object.values(titleObj)[0] || capId;
      } else if (typeof titleObj === 'string' && titleObj.trim().length > 0) {
        title = titleObj.trim();
      } else {
        title = _getDefaultCapabilityTitle(capId);
      }

      actions.push({
        id: capId,
        title,
        type: cap.type || (isButton ? 'button' : 'boolean'),
      });
    }
  }

  // If no quick actions were found, but device has target_temperature, provide it
  if (actions.length === 0 && capsObj.target_temperature && capsObj.target_temperature.setable !== false) {
    actions.push({
      id: 'target_temperature',
      title: 'Temperatura (Target)',
      type: 'number',
    });
  }

  // Sort: prioritize Homey default quickAction if present, then priority order, then alphabetical
  const homeyDefaultQa = device.ui?.quickAction;
  const priorityOrder = [
    'onoff',
    'locked',
    'button.unlatch',
    'unlatch',
    'button.open',
    'open',
    'garagedoor_closed',
    'windowcoverings_closed',
    'windowcoverings_state',
    'button',
    'target_temperature',
  ];

  actions.sort((a, b) => {
    if (homeyDefaultQa) {
      if (a.id === homeyDefaultQa) return -1;
      if (b.id === homeyDefaultQa) return 1;
    }
    const idxA = priorityOrder.indexOf(a.id);
    const idxB = priorityOrder.indexOf(b.id);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.id.localeCompare(b.id);
  });

  if (homey?.app?.log) {
    homey.app.log(`[api:_extractQuickActions] Device "${device.name}" (${device.id}) found ${actions.length} action(s): ${actions.map(a => `${a.title} [${a.id}]`).join(', ')}`);
  }

  return actions;
}

/**
 * Returns a human-friendly fallback title for standard capability IDs.
 *
 * @private
 * @param {string} capId
 * @returns {string}
 */
function _getDefaultCapabilityTitle(capId) {
  switch (capId) {
    case 'onoff': return 'On / Off';
    case 'locked': return 'Serratura (Chiudi)';
    case 'garagedoor_closed': return 'Garage / Cancello';
    case 'windowcoverings_closed': return 'Tapparelle / Tende';
    case 'windowcoverings_state': return 'Su / Giù';
    case 'button': return 'Pulsante';
    case 'unlatch':
    case 'button.unlatch': return 'Apri serratura';
    case 'open':
    case 'button.open': return 'Apri';
    case 'target_temperature': return 'Temperatura Target';
    default: {
      if (capId.startsWith('onoff.')) return `On / Off (${capId.replace('onoff.', '')})`;
      if (capId.startsWith('button.')) {
        const sub = capId.replace('button.', '');
        if (sub === 'unlatch') return 'Apri serratura';
        if (sub === 'open') return 'Apri';
        return `Pulsante (${sub})`;
      }
      if (capId.startsWith('locked.')) return `Serratura (${capId.replace('locked.', '')})`;
      return capId;
    }
  }
}

/**
 * Handles `GET /log/status`.
 *
 * @public
 * @param {object} args
 * @returns {Promise<object>}
 */
async function getLogStatus({ homey }) {
  try {
    const logManager = homey.app.getLogManager ? homey.app.getLogManager() : null;
    if (!logManager) {
      return { exists: false, files: [], totalSize: 0, debugEnabled: false };
    }

    const files = [];
    let totalSize = 0;

    for (let i = 0; i <= MAX_LOG_BACKUPS; i++) {
      const filePath = logManager.getLogFilePath(i);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        files.push({
          index: i,
          name: _getLogFileName(i),
          path: filePath,
          size: stats.size,
          sizeFormatted: _formatBytes(stats.size),
          modified: stats.mtime.toISOString(),
          isCurrent: i === 0,
        });
        totalSize += stats.size;
      }
    }

    return {
      exists: files.length > 0,
      files,
      totalSize,
      totalSizeFormatted: _formatBytes(totalSize),
      debugEnabled: logManager.isDebugEnabled(),
    };
  } catch (error) {
    homey.app.error('[api:getLogStatus] Error:', error.message || error);
    return { exists: false, error: error.message || error };
  }
}

/**
 * Handles `GET /log/download/:index`.
 *
 * @public
 * @param {object} args
 * @returns {Promise<string>}
 */
async function getLogDownloadFile({ homey, params }) {
  const index = parseInt(params.index, 10);
  if (isNaN(index) || index < 0 || index > MAX_LOG_BACKUPS) {
    throw Object.assign(new Error('Invalid file index'), { statusCode: 400 });
  }

  const logManager = homey.app.getLogManager();
  const filePath = logManager.getLogFilePath(index);
  const fileName = _getLogFileName(index);

  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`Log file not found: ${fileName}`), { statusCode: 404 });
  }

  const appId = homey.manifest ? homey.manifest.id : homey.app.id;
  const localAddress = await homey.cloud.getLocalAddress();
  return `http://${localAddress}/app/${appId}/userdata/${fileName}`;
}

/**
 * Handles `DELETE /log/:index`.
 *
 * @public
 * @param {object} args
 * @returns {Promise<object>}
 */
async function deleteLogFile({ homey, params }) {
  if (params && params.index === 'all') {
    return deleteAllLogs({ homey });
  }

  const index = parseInt(params.index, 10);
  if (isNaN(index) || index < 0 || index > MAX_LOG_BACKUPS) {
    throw Object.assign(new Error('Invalid file index'), { statusCode: 400 });
  }

  const logManager = homey.app.getLogManager();
  const filePath = logManager.getLogFilePath(index);
  const fileName = _getLogFileName(index);

  if (index === 0) logManager.clearWriteQueue();
  if (fs.existsSync(filePath)) {
    await fs.promises.unlink(filePath).catch(() => {});
  }

  return { success: true, deletedFile: fileName };
}

/**
 * Handles `DELETE /log/all`.
 *
 * @public
 * @param {object} args
 * @returns {Promise<object>}
 */
async function deleteAllLogs({ homey }) {
  const logManager = homey.app.getLogManager();
  await logManager.clearLogs();
  return { success: true };
}

module.exports = {
  startAuth,
  pollAuth,
  refreshAuth,
  getDashboards,
  getDevices,
  getZones,
  getLogStatus,
  getLogDownloadFile,
  deleteLogFile,
  deleteAllLogs,
};
