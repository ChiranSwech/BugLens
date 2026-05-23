# BugBuddy Testing Guide

Follow these steps to fully test the stabilized BugBuddy recording pipeline.

## 1. Start the Environment
Ensure both the backend and extension are ready. Run these commands in separate terminals if they aren't already running:

- **Backend (Required for Auth & Data)**: 
  ```bash
  pnpm --filter @bugbuddy/backend dev
  ```
- **Extension (Watch Mode)**:
  ```bash
  pnpm --filter @bugbuddy/extension dev
  ```

---

## 2. Prepare the Extension
1. Open Chrome and go to `chrome://extensions`.
2. Ensure **Developer mode** is ON (top right).
3. Find **BugBuddy** and click the **Reload** icon (circular arrow).
4. Go to any website (e.g., [petstore.octoperf.com](https://petstore.octoperf.com)) to start testing.

---

## 3. The Full Testing Flow

### A. Login
- Click the BugBuddy icon in your toolbar.
- Click **Continue with Google**.
- Once signed in, the popup will show "Ready to record".

### B. Record a Session
- Click **● Start Recording**.
- **Hover**: Move your mouse over header links or menus.
- **Click**: Click on links or buttons. You will see a **purple selection box** appear briefly.
- **Type**: Type into search bars or forms.
- **Scroll**: Scroll the page up and down.

### C. Review & Refine
- Open the popup again and click **■ Stop & Review**.
- The **SidePanel** will slide out from the right.
- **Check Readability**: Verify steps look like:
  - "Click on **FOR DOGS**"
  - "Type **'labrador'** in **Search**"
  - "Hover over **Main Menu**"
- **Check Merging**: Ensure that typing a word creates **one** step, not one step per letter.

### D. Submit the Bug
- Fill in the **Title** (e.g., "Checkout page alignment issue").
- Add a **Description**.
- Select a **Severity** (P0-P4).
- Click **Submit Bug Report**.
- You should see a green checkmark and "Bug Reported Successfully!".

---

## 4. Verification (Optional)
If you want to see the bug in the system, start the dashboard:
```bash
pnpm --filter @bugbuddy/frontend dev
```
Navigate to `http://localhost:3000` to view your submitted report.
