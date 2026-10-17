---
trigger: always_on
---

# Logging System & Security Guidelines

This rule defines the mandatory standards for all logging outputs, debugging statements, error handling, and sensitive data protection across the codebase.

---

## 1. Professional Standard & Prohibition of Non-Textual Symbols

Logs must strictly maintain a **professional and technical standard**:
* **Divieto Assoluto (Forbidden):** The use of **emoticons**, **emojis** (e.g., 🚀, ❌, ⚠️, ✅), **ASCII art**, or any non-textual symbols is **expressly forbidden** in all log outputs to ensure clean, structured, and parseable data.

---

## 2. Language Requirement

* **English Only:** All log messages, debug traces, warning notices, error descriptions, and inline code comments must **always** be written in **English**.

---

## 3. Structured Logging Format

Logs should follow a uniform, contextual structure that makes debugging and filtering in terminal logs (e.g., `homey app run`) straightforward:

* **Standard Format:** `[ClassName:methodName] message` or `[ModuleName] message`
* **Examples:**
  - `[App:onInit] Initializing application...`
  - `[DeviceManager:_setCapabilityValue] Setting onoff capability to true for device: living_room_light`
  - `[DiscoveryManager:discoverDevices] Found 12 devices on local network`

---

## 4. Native Homey Logging Methods

* **Class Context:** In classes extending `Homey.App`, `Homey.Driver`, `Homey.Device`, or flow card listeners, **always** prefer `this.log(...)` and `this.error(...)` over bare `console.log` or `console.error`.
* **Static / Helper Context:** In standalone utility modules or helpers where `this.log` is not available, provide a consistent logging wrapper or pass the logger instance.

---

## 5. Security & Protection of Personal and Sensitive Data

**⚠️ CRITICAL CONSTRAINT:** You must **❌ NEVER** log credentials, authentication tokens, or personally identifiable information (PII) in plain text.

### Strictly Forbidden in Logs:
1. **API Keys & Secrets:** API keys, consumer secrets, private tokens.
2. **Authentication Data:** User passwords, OAuth access tokens, refresh tokens, Bearer headers.
3. **Personal & Contact Data:** User **email addresses**, **phone numbers**, physical addresses, or GPS coordinates.

### Sanitization Rule:
Whenever it is necessary to confirm the presence of a credential or identifier for debugging, mask or truncate the value:
```javascript
// Correct: Masked
this.log(`[AuthService:login] Authenticating user with API key: ***${apiKey.slice(-4)}`);

// Incorrect (❌ NEVER do this):
this.log(`[AuthService:login] API Key: ${apiKey}, Email: ${userEmail}, Phone: ${userPhone}`);
```

---

## 6. Robust Error Handling

* **Explicit Error Logging:** When catching exceptions in `try/catch` blocks or asynchronous promise rejections, **always** log the error message:
  ```javascript
  try {
    // ...
  } catch (error) {
    this.error('[Service:execute] Operation failed:', error.message);
  }
  ```
* **No Silent Swallowing:** You must **❌ NEVER** use empty `catch` blocks that silently swallow exceptions without logging or propagating the error.