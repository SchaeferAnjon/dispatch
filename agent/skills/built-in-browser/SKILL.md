---
name: built-in-browser
description: "Use when the person says \"built-in browser\", wants you to look at, click, fill in, screenshot or sign in on a web page, or to open a page with a certain account (sign-in identity): how to open, read, click, fill in and screenshot in the browser in Dispatch IDE's side pane, and how to pick an identity; for sites that make images and video, such as Higgsfield, use their official interface first and the browser only for what it cannot do."
---

# built-in-browser: driving Dispatch's built-in browser

The built-in browser is the browser in Dispatch IDE's side pane. The person watches you work and can take over at any time by clicking the page. It keeps the person's sign-ins (they can be imported from Chrome) and can hold several **sign-in identities**: each identity has its own sign-ins, apart from the others (for example "Work" and "Personal", or a test user).

Do not switch to Claude in Chrome, the system browser (`open`), Playwright MCP or a Playwright script of your own unless the person names that one.

Talk to the person in the language they use with you.

## How to drive it

**Sessions in the Agents window** use the built-in browser tools (in Claude their names start with `mcp__client__`; load them with tool search first):

| To do | Tool |
|---|---|
| Open a URL (optionally with `profile`) | `openBrowserPage` |
| Read the page (title, URL, accessibility tree, elements with refs) | `readPage` |
| Click / type / press keys / hover / drag | `clickElement`, `typeInPage`, `hoverElement`, `dragElement` |
| Screenshot | `screenshotPage` |
| Go to a URL, go back | `navigatePage` |
| Dialogs (alert, confirm) | `handleDialog` |
| Anything the above cannot do (such as uploading a local file with `setInputFiles`) | `runPlaywrightCode` |

**Sessions in a terminal** use commands; behind them are the same browser and the same sign-ins:

```bash
dispatch browser --ide open https://example.com              # open (this page is remembered; later commands act on it)
dispatch browser --ide open https://mail.google.com --profile Work   # open with the "Work" identity
dispatch browser --ide read                                   # title, URL, accessibility tree (elements with refs such as e12)
dispatch browser --ide click "Sign in"                        # click by the visible name; when names repeat use the ref: click e14
dispatch browser --ide type "Email" "me@example.com" --submit # type into an input; --submit presses Enter afterwards
dispatch browser --ide press Enter                            # press a key
dispatch browser --ide shot                                   # screenshot; answers with a file path
dispatch browser --ide status                                 # the pages open in the side pane and the identity each uses
dispatch browser --ide size 1440x900                          # lay the page out at a desktop window's width, scaled into the side pane (when a site shows only its phone version); size off restores it
dispatch browser --ide profiles                               # the sign-in identities; * is the one new pages use
```

All take `--json`. When the IDE is not open, ordinary commands say so and use a separate browser instead; commands with an identity do not (identities live only in the IDE) and ask you to have the person open Dispatch IDE.

## The rhythm of each action: read → act → read again

1. `read` to see what is on the page and find what to click (its name or ref).
2. Take one step: click, type, press a key.
3. `read` again (or take a screenshot) to confirm the result before the next step. After the page changes (navigation, a dialog, a re-render) old refs no longer work.

## Sign-in identities

- When the person says "use my work account", "use the test account" or "open it as Work": pass the identity's name (`profile` for the tool, `--profile` for the command). Otherwise pass none, and the page uses the identity the person picked last.
- Check which exist with `profiles` first. When the one the person means is missing: ask them, or make an empty one with `dispatch browser --ide profiles --add "Test user"` and ask the person to sign in on the page themselves.
- The identity button is at the very front of the address bar (a small person icon with the name; the interface calls it Browser profile). The person switches, creates, renames and deletes identities there, and can import Chrome's sign-ins into one.
- To reproduce "a problem only some user has", open the page with that user's identity; do not sign in and out inside the person's own identity.

## Rules

- When the person clicks or types on the page, or presses Stop on the floating bar: stop, say how far you got and ask what next; do not retry.
- When the page is covered by a dialog, a menu or the command palette, nothing happened: tell the person what you were about to do and ask them to close it, then try again.
- **The person signs in themselves**: never type passwords or codes for them; when a sign-in is needed, stop, ask them to sign in on the page, and go on once they have.
- **Ask before spending money**: before ordering, paying, subscribing or using up credits (generating a video, for example), tell the person what it costs and wait for their yes.
- Uploading a local file: in the Agents window use `runPlaywrightCode` with `setInputFiles` on the file input; the terminal commands cannot upload yet, so ask the person to drag the file onto the page.

## Sites that make images and video, such as Higgsfield

Look for an official interface first, and use the browser only for what it cannot do. The official interface is faster and steadier, and nobody has to watch the page.

**Higgsfield** (checked 2026-10) has an official hosted MCP server that uses the person's own Higgsfield account and credits; sign-in is authorized in the browser, no API key:

```bash
dispatch mcp add higgsfield        # writes it into the MCP settings of Claude Code, Codex and OpenCode
# then sign in once per engine:
#   Claude Code: in an interactive session /mcp → higgsfield → Authenticate
#   Codex: codex mcp login higgsfield
#   OpenCode: opencode mcp auth higgsfield
```

Its tools are `generate_image`, `generate_video`, `create_character`, `list_characters` and `get_generation_status` (generation is asynchronous; check the result with status after submitting). It also has an official command line, `npm i -g @higgsfield/cli` (sign in with `higgsfield auth login`), which works in a terminal too.

For what the interface lacks (editors, templates and community work found only on the website), use the built-in browser:

(Checked in the built-in browser on 2026-10-06 up to "Generate", without spending credits.)

1. Open the image or video page directly: `open "https://higgsfield.ai/ai/image?model=nano-banana-pro"` (video is `/ai/video?model=…`; the home page links every model); add `--profile` when the person names an account. The site keeps loading video, so `open` may answer that the page is open and still loading: just `read` after a few seconds, no need to open it again.
2. **In a narrow side pane it serves the phone version**: the image page shows no prompt box and `/generate` shows "Mobile Access Coming Soon". First lay the page out at a desktop window's width: `dispatch browser --ide size 1440x900` (sessions in the Agents window use this command too, not `runPlaywrightCode` to change the viewport). It uses the built-in browser's own device emulation: the page is laid out 1440 wide and scaled into the side pane, so the person still sees the whole page; `size off` restores it afterwards.
3. When a Cookie Notice appears at the bottom, click "Reject Non-Essential Cookies"; never accept advertising cookies for the person.
4. In `read` the prompt box is a `textbox` without a name (next to it: Describe the scene you imagine); fill it by ref: `type e161 "…"`. **Do not add `--submit`**: Enter may start generating right away.
5. The row below holds the settings, all buttons: the model (showing its name, such as "Nano Banana Pro"), the ratio ("3:4"), the resolution ("1K"), the count ("1/4", with Decrement / Increment on its sides), Draw; References and Elements upload reference pictures (upload local pictures as described under "Uploading a local file" above).
6. On the right is "Generate"; the number on the button is what this costs in credits ("Generate 2" is 2 credits). **Before clicking it**, tell the person the model, the settings and the credits, and wait for their yes. "Login" and "Sign up" at the top mean nobody is signed in: stop and ask the person to sign in themselves.
7. Generating takes from tens of seconds to minutes: `read` or take a screenshot now and then to follow it, and give the person the result's link or screenshot when it is done.

Other sites work the same way: first check `dispatch mcp presets` for a ready interface, then whether the site has an official MCP or command line, and only then use the browser.
