---
trigger: glob
description: Mandatory architectural, structural, and visual design guidelines for Homey Pro app settings pages (settings/index.html).
globs: ["**/settings/**", "**/settings/index.html"]
---

# Homey Pro Settings UI Guidelines (`settings/index.html`)

This rule defines the mandatory architectural structure, visual design system, navigation patterns, and JavaScript standards for all settings pages (`settings/index.html`) in Homey Pro SDK v3 applications.

---

## 1. Core Principles

1. **SPA Architecture (Single Page Application)**: Never reload the page or use multiple HTML files for settings. Use a single `settings/index.html` with view-switching containers (`.view` and `.view.is-active`).
2. **Main Menu Header Standard**: The initial menu view (`#view-menu`) MUST feature a standardized top header `<header class="homey-header" style="margin-bottom: 10px;"><h1 class="homey-title" data-i18n="settings.menu.title"></h1></header>` where the title text strictly follows the standard format `"Impostazioni + [Nome App]"` (in Italian: `"Impostazioni [Nome App]"`, in English: `"[App Name] Settings"`).
3. **Submenu Item Cards & Exact Titles**: Every submenu entry in the main menu list MUST have a `.menu-item-text` container with `<span class="menu-item-title" data-i18n="..."></span>` where the text strictly matches the exact name of the destination submenu/section, paired with `<span class="menu-item-subtitle" data-i18n="..."></span>` for its description.
4. **Zero Hardcoded Strings**: All user-visible strings MUST be localized using `data-i18n` attributes in HTML and `Homey.__('...')` in JavaScript. Support both English (primary, `locales/en.json`) and Italian (`locales/it.json`).
5. **Consistent Brand Identity**: Define brand colors in `:root` CSS variables and apply them consistently to icons, borders, active states, and buttons.
6. **Top Navigation (Back Button)**: Every sub-view MUST include a standardized back button (`.back-item.back-btn`) at the very top, before the view header.
7. **Toast Notification System**: Provide feedback for all user actions (save, error, delete, action in progress) using a fixed, centered toast notification.
8. **Dark Mode & Theming Compatibility**: All UI components must render seamlessly in both Light and Dark modes using CSS variables and `@media (prefers-color-scheme: dark)`.
9. **Code Standards**: All JavaScript comments and JSDoc MUST be in English. All private functions and methods MUST start with an underscore (`_`).
10. **Toggle Switches for Binary Settings**: All binary settings, feature toggles, and on/off preferences MUST use the native iOS/Homey toggle switch (`.toggle-switch` / `.toggle-slider`) instead of standard checkboxes.

---

## 2. HTML Architecture & View Structure

The settings page must be structured inside a `.content` wrapper with a Main Menu (`#view-menu`) and individual Sub-Views (`#view-<section>`):

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Settings</title>
  <!-- The '/homey.js' script must be included in your settings view to work -->
  <script type="text/javascript" src="/homey.js" data-origin="settings"></script>
  <style>
    /* CSS Styles (see Section 4) */
  </style>
</head>
<body>
  <div class="content">

    <!-- View 0: Main Menu -->
    <div id="view-menu" class="view is-active">
      <!-- MANDATORY: Header in the initial menu view -->
      <header class="homey-header" style="margin-bottom: 10px;">
        <h1 class="homey-title" data-i18n="settings.menu.title"></h1>
      </header>

      <form class="homey-form">
        <fieldset class="homey-form-fieldset">
          <div class="menu-list-container">

            <!-- Submenu 1: Menu Item Card -->
            <div id="nav_general" class="menu-item" role="button" tabindex="0">
              <div class="menu-item-content">
                <div class="menu-item-icon">
                  <!-- SVG Icon -->
                </div>
                <div class="menu-item-text">
                  <span class="menu-item-title" data-i18n="settings.menu.general_title"></span>
                  <span class="menu-item-subtitle" data-i18n="settings.menu.general_desc"></span>
                </div>
              </div>
              <div class="menu-item-arrow">›</div>
            </div>

            <!-- Submenu 2: Account / Connection -->
            <div id="nav_account" class="menu-item" role="button" tabindex="0">
              <div class="menu-item-content">
                <div class="menu-item-icon">
                  <!-- SVG Icon -->
                </div>
                <div class="menu-item-text">
                  <span class="menu-item-title" data-i18n="settings.menu.account_title"></span>
                  <span class="menu-item-subtitle" data-i18n="settings.menu.account_desc"></span>
                </div>
              </div>
              <div class="menu-item-arrow">›</div>
            </div>

          </div>
        </fieldset>
      </form>
    </div>

    <!-- View 1: Sub-View (e.g. Account) -->
    <div id="view-account" class="view">
      <!-- MANDATORY: Back button at the very top of each sub-view -->
      <div class="menu-item back-item back-btn" role="button" tabindex="0">
        <div class="menu-item-arrow">‹</div>
        <div class="menu-item-text">
          <span class="menu-item-title" data-i18n="settings.common.back"></span>
        </div>
      </div>

      <header class="homey-header" style="margin-top: 10px; margin-bottom: 20px;">
        <h1 class="homey-title" data-i18n="settings.account.title"></h1>
        <p class="subtitle" data-i18n="settings.account.subtitle"></p>
      </header>

      <!-- Sub-view content -->
    </div>

  </div>

  <!-- Toast Notification Container (Fixed at bottom) -->
  <div id="toast" class="toast"></div>

  <script type="text/javascript">
    /* JavaScript logic (see Section 5) */
  </script>
</body>
</html>
```

---

## 3. Mandatory UI Components

### A. Main Menu Header (`.homey-header`)
Every settings page MUST include a standardized header at the top of `#view-menu`:
```html
<header class="homey-header" style="margin-bottom: 10px;">
  <h1 class="homey-title" data-i18n="settings.menu.title"></h1>
</header>
```
* **Title Rule**: The title text bound to `settings.menu.title` must strictly follow `"Impostazioni + [Nome App]"` (e.g. `"Impostazioni [Nome App]"` in Italian, `"[App Name] Settings"` in English).

### B. Submenu Item Cards (`.menu-item`)
Every submenu card in `#view-menu` MUST include a `.menu-item-title` where the text strictly matches the submenu name:
```html
<div id="nav_general" class="menu-item" role="button" tabindex="0">
  <div class="menu-item-content">
    <div class="menu-item-icon">
      <!-- SVG Icon (24x24 or 28x28 viewBox) -->
    </div>
    <div class="menu-item-text">
      <span class="menu-item-title" data-i18n="settings.menu.general_title"></span>
      <span class="menu-item-subtitle" data-i18n="settings.menu.general_desc"></span>
    </div>
  </div>
  <div class="menu-item-arrow">›</div>
</div>
```

### C. Back Button (`.back-item.back-btn`)
Placed at the top of every sub-view before the header:
```html
<div class="menu-item back-item back-btn" role="button" tabindex="0">
  <div class="menu-item-arrow">‹</div>
  <div class="menu-item-text">
    <span class="menu-item-title" data-i18n="settings.common.back"></span>
  </div>
</div>
```

### D. Toast Notification (`#toast`)
Fixed at the bottom center of the screen with auto-dismiss:
```html
<div id="toast" class="toast"></div>
```

### E. Status Card (`.status-card`)
Used for displaying connection status and metadata:
```html
<div class="status-card">
  <div class="status-header">
    <span class="status-header-title" data-i18n="settings.status.card_title"></span>
    <span id="account-status-badge" class="status-badge connected" data-i18n="settings.status.connected"></span>
  </div>
  <div id="status-details-section">
    <div class="info-row">
      <span class="info-label" data-i18n="settings.status.item_label"></span>
      <span id="status-item-value" class="info-value">-</span>
    </div>
  </div>
</div>
```

### F. Notice Box (`.notice-box.warning` or `.notice-box.info`)
Used for warnings, tips, and instructions:
```html
<div class="notice-box info">
  <h4 data-i18n="settings.notice.info_title"></h4>
  <span data-i18n="settings.notice.info_desc"></span>
</div>
```

### G. Loading Spinner (`.loading-spinner`)
Embedded inside buttons or next to async actions:
```html
<button id="btn-save" type="button" class="homey-button-primary-shadow">
  <span data-i18n="settings.common.save"></span>
  <span id="save-spinner" class="loading-spinner" style="display: none;"></span>
</button>
```

### H. Native Toggle Switch (`.toggle-switch`)
All boolean preferences, feature toggles, and on/off settings MUST use the native iOS/Homey toggle switch component instead of standard checkboxes:
```html
<div class="setting-toggle-row">
  <div class="setting-toggle-text">
    <label class="setting-toggle-label" for="setting_key" data-i18n="settings.section.key_label"></label>
    <p class="form-help-text" data-i18n="settings.section.key_help"></p>
  </div>
  <label class="toggle-switch">
    <input type="checkbox" id="setting_key" />
    <span class="toggle-slider"></span>
  </label>
</div>
```

---

## 4. Standard CSS Styles (with Dark Mode Support)

Always include these base styles in `<style>`:

```css
:root {
  --brand-color: #00a8e1;
  --brand-color-hover: #0090c2;
  --brand-color-light: rgba(0, 168, 225, 0.1);
  --bg-card: rgba(255, 255, 255, 0.7);
  --bg-card-hover: rgba(0, 0, 0, 0.03);
  --bg-back-btn: #ffffff;
  --text-primary: #333333;
  --text-secondary: #666666;
  --border-color: rgba(0, 0, 0, 0.1);
  --border-light: rgba(0, 0, 0, 0.05);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-card: rgba(44, 44, 46, 0.7);
    --bg-card-hover: rgba(255, 255, 255, 0.05);
    --bg-back-btn: #2c2c2e;
    --text-primary: #f2f2f7;
    --text-secondary: #aeaeb2;
    --border-color: rgba(255, 255, 255, 0.12);
    --border-light: rgba(255, 255, 255, 0.06);
  }

  .toggle-slider {
    background-color: #39393d;
  }

  .toggle-switch input:checked + .toggle-slider {
    background-color: #34c759 !important;
  }
}

body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  margin: 0;
  overflow-x: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: var(--text-primary);
}

.content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  padding: 10px 15px 30px 15px;
  box-sizing: border-box;
}

.homey-button-primary-full {
  width: 100%;
}

/* Views */
.view {
  display: none;
}

.view.is-active {
  display: block;
}

/* Subtitle */
.subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 6px;
  margin-bottom: 20px;
}

/* Main Menu List */
.menu-list-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 15px;
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  background-color: var(--bg-card);
  cursor: pointer;
  transition: background-color 0.2s, transform 0.1s, border-color 0.2s;
  text-decoration: none;
  color: inherit;
}

.menu-item:hover {
  background-color: var(--bg-card-hover);
  border-color: var(--brand-color);
}

.menu-item:active {
  transform: scale(0.98);
}

.menu-item-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.menu-item-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand-color);
  flex-shrink: 0;
}

.menu-item-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.menu-item-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.menu-item-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
}

.menu-item-arrow {
  color: #999;
  font-size: 20px;
  font-weight: bold;
}

/* Back Button */
.back-item {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 20px;
  border-color: var(--border-color);
  background-color: var(--bg-back-btn);
  justify-content: flex-start !important;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.back-item .menu-item-text {
  flex: initial;
}

.back-item .menu-item-title {
  color: var(--brand-color);
  font-size: 15px;
  font-weight: 600;
}

.back-item .menu-item-arrow {
  color: var(--brand-color);
  font-size: 20px;
  font-weight: bold;
}

/* Status Cards & Badges */
.status-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  background-color: var(--bg-card);
  margin-bottom: 20px;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.status-header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.status-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
}

.status-badge.connected {
  background-color: rgba(40, 167, 69, 0.15);
  color: #28a745;
}

.status-badge.disconnected {
  background-color: rgba(220, 53, 69, 0.15);
  color: #dc3545;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-light);
  font-size: 13px;
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  color: var(--text-secondary);
}

.info-value {
  font-weight: 500;
  color: var(--text-primary);
  font-family: monospace;
}

/* Notice Box */
.notice-box {
  margin-top: 20px;
  padding: 16px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
}

.notice-box.warning {
  background-color: #fff3cd;
  border: 1px solid #ffeeba;
  color: #856404;
}

.notice-box.info {
  background-color: var(--brand-color-light);
  border: 1px solid rgba(0, 168, 225, 0.3);
  color: #00739c;
}

.notice-box h4 {
  margin: 0 0 6px 0;
  font-size: 14px;
}

/* Loading Spinner */
.loading-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-radius: 50%;
  border-top-color: var(--brand-color);
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
  margin-left: 6px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Toast Notifications */
.toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 20px;
  background-color: #28a745;
  color: white;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
  z-index: 1000;
  text-align: center;
  max-width: 90%;
}

.toast.show {
  opacity: 1;
}

.toast.success {
  background-color: #28a745;
}

.toast.error {
  background-color: #dc3545;
}

.toast.warning {
  background-color: #ffc107;
  color: #856404;
}

/* iOS / Homey Native Toggle Switch */
.setting-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}

.setting-toggle-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
}

.setting-toggle-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
}

.form-help-text {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 28px;
  flex-shrink: 0;
  cursor: pointer;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #e9e9ea;
  transition: background-color 0.25s ease;
  border-radius: 28px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 24px;
  width: 24px;
  left: 2px;
  bottom: 2px;
  background-color: #ffffff;
  transition: transform 0.25s ease;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.toggle-switch input:checked + .toggle-slider {
  background-color: #34c759 !important;
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
}
```

---

## 5. Standard JavaScript Structure

Every `onHomeyReady(Homey)` implementation MUST follow this structure:

```javascript
/**
 * onHomeyReady is called when the Homey environment is loaded and ready.
 * @param {Object} Homey - Homey Settings API instance
 */
function onHomeyReady(Homey) {
  Homey.ready();

  // 1. View Switching Setup
  const viewMenu = document.getElementById('view-menu');
  const viewAccount = document.getElementById('view-account');
  const views = [viewMenu, viewAccount];

  /**
   * Switch between SPA views.
   * @private
   * @param {HTMLElement} targetView - The view element to activate
   */
  function _showView(targetView) {
    views.forEach(v => {
      if (v) v.classList.remove('is-active');
    });
    if (targetView) {
      targetView.classList.add('is-active');
    }
    window.scrollTo(0, 0);
  }

  // 2. Navigation Handlers
  document.getElementById('nav_account').addEventListener('click', function () {
    _showView(viewAccount);
    _loadAccountData();
  });

  // 3. Back Button Handlers (Return to Main Menu)
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      _showView(viewMenu);
    });
  });

  // 4. Toast Notification Helper
  /**
   * Show a toast notification with message and style type.
   * @private
   * @param {string} message - Message text
   * @param {string} [type='success'] - Toast style type: 'success', 'error', 'warning'
   */
  function _showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('success', 'error', 'warning');
    toast.classList.add(type);
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // 5. Data Persistence & API Handlers
  /**
   * Example: Load settings via native Homey.get or custom Homey.api
   * @private
   */
  function _loadAccountData() {
    // Native settings retrieval
    Homey.get('user_settings_key', function (err, value) {
      if (err) {
        _showToast(Homey.__('settings.common.error_generic'), 'error');
        return;
      }
      // Populate fields...
    });

    // Or custom Web API retrieval
    Homey.api('GET', '/status', null, function (err, status) {
      if (err) {
        _showToast(Homey.__('settings.common.error_generic'), 'error');
        return;
      }
      // Update UI elements...
    });
  }

  /**
   * Example: Save settings via native Homey.set
   * @private
   */
  function _saveSettings(key, value) {
    Homey.set(key, value, function (err) {
      if (err) {
        _showToast(Homey.__('settings.common.error_generic'), 'error');
        return;
      }
      _showToast(Homey.__('settings.common.saved'), 'success');
    });
  }
}
```

---

## 6. Localization Rules (`locales/*.json`)

Every settings view MUST define its keys in `locales/en.json` and `locales/it.json`:

```json
{
  "settings": {
    "menu": {
      "title": "[App Name] Settings",
      "general_title": "General",
      "general_desc": "General application preferences",
      "account_title": "Account & Connection",
      "account_desc": "Connection status and credentials"
    },
    "general": {
      "title": "General Settings",
      "subtitle": "Configure global application behavior"
    },
    "account": {
      "title": "Account Configuration",
      "subtitle": "Manage your connection credentials and status"
    },
    "status": {
      "card_title": "Connection Status",
      "connected": "Connected",
      "disconnected": "Disconnected",
      "item_label": "Identifier"
    },
    "notice": {
      "info_title": "Information",
      "info_desc": "Please verify your configuration before saving."
    },
    "common": {
      "back": "Back",
      "save": "Save",
      "saved": "Settings saved successfully",
      "confirm": "Confirm",
      "cancel": "Cancel",
      "loading": "Loading...",
      "not_available": "N/A",
      "error_generic": "An error occurred"
    }
  }
}
```