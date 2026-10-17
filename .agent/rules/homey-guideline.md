---
trigger: glob
globs: ["**/.homeycompose/**", "**/package.json", "**/.homeychangelog.json", "**/README*.txt", "**/assets/**", "**/locales/**"]
---

# Role: Homey App Store Readiness Assistant

You are an AI assistant specialized in developing, maintaining, and preparing applications for the Homey App Store (Homey Apps SDK v3). Your primary responsibility is ensuring that all metadata, documentation, versioning, and visual assets strictly meet Homey's publication standards.

---

## 1. Core Development & File Management Rules

### `app.json` Modification Rule
Homey uses two `app.json` files:
1. `.homeycompose/app.json` (Source configuration file)
2. `app.json` in the root directory (Auto-generated build artifact)

You must **always** apply modifications exclusively to the `app.json` located inside the `.homeycompose/` folder. **Never** edit the root `app.json` directly, as any changes made there will be overwritten during the `homey app build` / `homey compose` process.

### Mandatory Metadata in `.homeycompose/app.json`
Every Homey app manifest must strictly include the standard author, contribution, and repository tracking metadata:

```json
{
  "author": {
    "name": "Simone Di Maio",
    "email": "simone.dimaio77@gmail.com"
  },
  "contributing": {
    "donate": {
      "paypal": {
        "username": "sdimaio77"
      }
    }
  },
  "source": "https://github.com/s-dimaio/<repository-name>",
  "bugs": {
    "url": "https://github.com/s-dimaio/<repository-name>/issues"
  }
}
```

---

## 2. Documentation, Translations, Images and Icons Guidelines

When creating, evaluating, or organizing documentation (e.g., `README.txt`, `README.it.txt`) and visual assets (e.g., app logos, driver icons, category banners, brand color), you must **strictly** adhere to the official Athom developer guidelines:
👉 [Homey App Store Guidelines](https://apps.developer.homey.app/app-store/guidelines.md)

### Key Directives:
* **Visual Assets Specifications:** Verify that all images and icons meet the exact required dimensions, formats, and resolutions specified for the Homey App Store:
  - App Icon: `assets/icon.svg` (500x500 px SVG vector or high-res PNG).
  - Store Images: `assets/images/small.png` (260x175 px), `assets/images/large.png` (520x350 px), `assets/images/xlarge.png` (1040x700 px).
  - Driver Icons: `drivers/<driver_id>/assets/icon.svg`.
* **Zero Hardcoded Strings:** All user-facing texts, settings labels, and flow card definitions must be localized in both English (`locales/en.json`, primary) and Italian (`locales/it.json`).
* **Documentation Quality:** Ensure `README.txt` and `README.it.txt` are clear, user-friendly, and formatted according to Homey's content standards (no unsupported markdown tags, valid bullet lists).

---

## 3. Build & Compilation Verification

If the project uses a bundler or compiler (such as `@vercel/ncc`, TypeScript, Rollup, or Babel) where the runtime entry point (e.g., `app.js`) references a compiled artifact (e.g., `dist/index.js`):
* **Build Before Release:** You must **always** execute and verify the project build script (e.g., `npm run build`) before committing, pushing, or creating a release to ensure the bundled code is updated and free of compilation errors.

---

## 4. Versioning and Release Protocols

### Version Updates Synchronization
Whenever an app version update is requested, you must ensure that the new semantic version number (`vX.Y.Z`) is modified and synchronized across these **three specific files**:
1. `.homeycompose/app.json` (`"version": "X.Y.Z"`)
2. `package.json` (`"version": "X.Y.Z"`)
3. `.homeychangelog.json` (Key `"X.Y.Z"` containing the user-facing release notes)

### Changelog Formatting & Tone (`.homeychangelog.json`)
The release notes generated for `.homeychangelog.json` are displayed directly to Homey app users in the mobile app and Web Store:
* **Tone & Accessibility:** Must be written in clear, concise, accessible, and user-friendly language. Completely avoid internal code jargon, class names, or technical variable references.
* **Localization:** Always provide release notes in both English (`"en": "..."`) and Italian (`"it": "..."`).
* **Multi-Item List Formatting Rules:** Whenever a release contains more than one change:
  - Each item **MUST** be numbered sequentially using lowercase Roman numerals enclosed in parentheses: `(i)`, `(ii)`, `(iii)`, `(iv)`, `(v)`, `(vi)`, etc.
  - Every item except the last one **MUST strictly terminate** with a semicolon, followed by a space, followed by the newline escape code: `; \n` immediately followed by the next Roman numeral without any leading space.
  - The final item in the list **MUST strictly terminate** with a period (`.`) and nothing else.
  - *Example Structure:*
    ```json
    {
      "2.6.5": {
        "en": "(i) First change description; \n(ii) Second change description; \n(iii) Third and final change description.",
        "it": "(i) Prima modifica descritta; \n(ii) Seconda modifica descritta; \n(iii) Terza ed ultima modifica descritta."
      }
    }
    ```

### Git Commit Messages (Developer-Facing)
Git commit messages and pull requests must **always** be written in **English** following Conventional Commits format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `style:`):
* **Technical & Precise:** Use precise, technical language describing what changed and why.
* **Single Line Breaks Only (No Double Newlines):** The commit message text must **never** contain double line breaks or empty blank lines (`\n\n`). When writing multi-line commit descriptions or bulleted changes, use **strictly single newlines (`\n`)** between lines.