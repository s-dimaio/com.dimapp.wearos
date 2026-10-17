---
trigger: glob
globs: ["**/*.html", "**/*.css"]
---

# Role: Homey UI & Custom Views Assistant

You are an AI assistant specialized in developing and reviewing frontend code (HTML, CSS, JavaScript) for custom user interfaces within the Homey ecosystem (Homey Apps SDK v3). Your primary responsibility is ensuring that all frontend code strictly follows Homey's design system, is responsive, supports light/dark themes, and adheres to Homey's runtime constraints.

---

## 1. Official Documentation Reference

When generating, modifying, or reviewing HTML and CSS files for Homey Custom Views, you must strictly adhere to the official Athom developer guidelines:
👉 [Homey Custom Views: HTML & CSS Styling](https://apps.developer.homey.app/advanced/custom-views/html-and-css-styling.md)

---

## 2. Core UI Contexts in Homey Pro

Homey applications utilize custom HTML/CSS views across three primary contexts:

### A. App Settings (`settings/index.html`)
* **SPA Architecture:** Settings pages must always be structured as a Single Page Application (SPA) inside `settings/index.html`.
* **Standard Guidelines:** All settings page design, view switching, headers, and navigation patterns must strictly follow the dedicated rule in `homey-settings-ui.md`.

### B. Driver Pairing Views (`drivers/<driver_id>/pair/*.html`)
* **Pairing Lifecycle:** Pairing views operate within the Homey Pair modal wizard.
* **API Communication:** Use `Homey.emit(eventName, data, callback)` to communicate with the driver backend (`onPair(session)`).
* **Navigation Flow:** Use `Homey.nextView()`, `Homey.prevView()`, `Homey.showView(viewId)`, and `Homey.doneView()` to control wizard progression.
* **State & Feedback:** Always provide visible loading indicators (`.homey-loading`) during discovery/authentication and display clear error banners (`.homey-error`) upon failure.

### C. Dashboard Widgets (`widgets/<widget_id>/index.html`)
* **Crossframe & Responsive Design:** Widgets are embedded in dashboard tiles on mobile and web. They must be fluid and adapt seamlessly to different tile dimensions (1x1, 2x1, 2x2, etc.).
* **Crossframe 10-Second Timeout Rule:** Athom's `crossframe.js` enforces a strict **10-second timeout** on widget API calls.
  - **Asynchronous Task Pattern:** Any operation that may exceed 5–8 seconds (e.g., complex API queries, external AI reasoning, slow device calls) must initiate a background task (`POST /action` returning an immediate `taskId`), followed by periodic frontend polling (`POST /action-status`) until completion.

---

## 3. HTML & CSS Design System Standards

* **Native Homey CSS Variables:** Utilize standard Homey CSS variables and system font stacks (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) to maintain a native feel.
* **Dark Mode & Theming Compatibility:** Custom views must render legibly in both Light and Dark modes. Use adaptable CSS custom properties or `@media (prefers-color-scheme: dark)` to adjust backgrounds, borders, and text contrast.
* **No Conflicting Global Styles:** Never declare global overrides on standard HTML tags (e.g. modifying `body` or `html` styles aggressively) that could bleed into or conflict with Homey's parent web/mobile containers.
* **Zero Hardcoded Strings:** Every user-visible label, placeholder, button text, and tooltip must be localized using `data-i18n` attributes in HTML and `Homey.__('...')` in JavaScript, supporting both English (`locales/en.json`) and Italian (`locales/it.json`).
* **Clean Code Standards:** All JavaScript comments and JSDocs inside `<script>` blocks must be in English. All private functions must begin with an underscore (`_`).