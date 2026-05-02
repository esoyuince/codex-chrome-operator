# Live-Test Findings

## Profile And Reload

- A successful install does not guarantee the active Chrome instance loaded the new extension code.
- For background/content/debugger changes, close all Chrome processes after install and launch through `ensure-started`.
- Confirm the launch mode is `configured-real-profile` and the command line includes the real user data dir plus `--profile-directory=Default`.
- Confirm `extensionVersion`, `bridgeVersion`, and `lastMismatch` in `operator-cli status`.

## False Auth Gates

Observed failure: normal feed text containing sign-in language triggered `AUTH_REQUIRED`.

Best practice:

- Text patterns such as "sign in" should trigger auth gates only when visible auth fields are also present.
- CAPTCHA, WebAuthn, OTP, and explicit blocking gates may still rely on their own signals.
- Add regression tests using normal feed/post content containing auth phrases.

## Repeated Controls And Stale Handles

Observed failure: X reply buttons share weak fingerprints; stale recovery returned `RECOVERY_NOT_UNIQUE` with over 100 matches.

Best practice:

- Include stable layout fingerprint information in handle descriptors.
- Track original fingerprint counts so repeated controls can recover by stable index only when the repeated set remains aligned.
- Preserve ambiguity protection for single-to-many or drifted targets.
- In debugger target recovery, do not treat `data-testid` alone as unique on feeds. Pair it with label, href, role, or position evidence.

## Explicit Target Summaries

Observed failure: callers supplied an explicit target, but preflight/debugger paths still used a generic content-derived target.

Best practice:

- Keep `params.target` as the strongest caller intent.
- If content preflight fails only with `STALE_HANDLE` and a caller target exists, let debugger target recovery attempt the action.
- When content preflight succeeds, pass `params.target || preflight.result.target` to the debugger, not only the preflight target.

## React And Contenteditable Typing

Observed failure: debugger typing set visible text in X's contenteditable textbox, but the `Yanıtla` button stayed disabled. The DOM looked filled, while React state did not accept the input.

Best practice:

- Treat "visible text appears" and "app state accepted input" as separate verification points.
- For contenteditable React editors, prefer real input fidelity: focus, selection, beforeinput/input events, or Chrome debugger `Input.insertText`/keyboard events.
- After typing, verify the send/submit control is enabled before clicking.
- If a submit button stays disabled, do not claim the public action was completed.

## X Reply Submission

Observed behavior: X's intent URL reliably opened a prefilled reply composer and built the GitHub URL card, but the page also rendered an inline duplicate composer below the modal. Fresh observe handles could go stale almost immediately because the home timeline kept updating, and debugger click recovery returned `RECOVERY_NOT_UNIQUE` for duplicate `Yanıtla` controls.

Observed behavior: a content `page.batch` click on the modal `tweetButton` returned `clicked`, but the composer stayed open and the reply was not posted. X appeared to ignore the programmatic/untrusted click even though the DOM action succeeded.

Best practice:

- Use `https://x.com/intent/post?in_reply_to=<tweet-id>&text=<urlencoded-text>` to prepare replies when possible.
- Wait for the URL card preview and enabled `Yanıtla` button before attempting submit.
- If individual click returns stale/ambiguous and content batch reports `clicked` without closing the composer, do not count it as a successful submit.
- After explicit user authorization, foreground Chrome and send an OS-level `Ctrl+Enter` key event to the open composer; then wait and re-observe.
- Verify success from the new account-authored status link, for example `https://x.com/<account>/status/<id>`, not from a click result alone.
- Check for leftover top-level composer drafts after a keyboard fallback so a duplicate standalone post is not left ready to publish.

## Public Action Safety

- Posting, purchase, checkout, and upload actions need explicit user authorization.
- For social posting tests, keep comments relevant and low-volume.
- Verify after submit by checking that the compose box cleared, reply count changed, or the posted text appears as an account-authored reply.
