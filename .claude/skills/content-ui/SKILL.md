---
name: content-ui
description:
  "Product UI text style: labels, form hints, empty states, errors, destructive confirmations,
  success states, transactional email, and how UI text matches CLI and MCP output. Use when writing
  or reviewing any text a product screen, API error or transactional email shows to a builder."
---

# Content Style: Product UI

Text inside the product: button and link labels, form labels and hints, empty states, error and
validation messages, confirmations, success states, page titles and transactional email. This
specializes the brand voice (the `brand` skill) for one content category. Positioning, voice,
anti-voice and rhetorical devices are settled there and are not restated. What follows is how that
voice produces UI text specifically. Agent-authoritative once landed.

## Principles

- **Sentence case everywhere.** Buttons, headings, page titles, `<title>` and SEO titles, tabs, menu
  items and email subjects: "Billing and usage", "Sign in", "Not found". Capitalize only the first
  word and proper nouns.
- **One word per thing, on every surface.** The app, the API, email, the CLI and MCP name an object
  and an action identically. When two words compete, pick one and change the other surface. A
  synonym is a second concept to the reader.
- **US spelling.** All product text uses US English: "color", "canceled", "organization".
- **Literal over clever.** Name the object the builder sees, not the mechanism: "Create token", not
  "Mint token". A technical term comes with the plain statement, never on its own.
- **Low on the scale.** A routine event is a message or a notification, not an alert: "{automation
  name} sent a notification", never "Alert from {automation name}". Keep "alert" for something that
  needs action.
- **The agent is a light mention.** Where UI text names the AI agent, it's something the builder
  works with, never the subject of the sentence.
- **The interface states the default.** Don't ask the builder to choose what the product can choose.
  A setting with a sensible default says what that default does.

## Names

Each object has one name on every surface. Use these, and add a new object here when it ships.

- **Scope** groups devices. Never "space".
- **Device** is a connected device only. What a session signs in from is a **browser**.
- **Automation** watches for something happening and does something about it. Never "trigger" or
  "action" as objects.
- **Dashboard** shows devices' readings and controls.
- **Activity** is the team's record of what happened. Never "logs".
- **Team**, **member** and **role**: a member is a person on a team; a role (owner, manager, viewer)
  is what a member or token may do, not a page of its own.
- **Invite**, noun and verb: "Invite member", "Pending invites", "Review invite". Never
  "invitation".
- **Delete account**: the action and its outcome. A deleted account can be restored until its data
  is removed for good. Never "close" or "erase".
- **Project** is only the builder's code folder that the CLI deploys. Never the team, the account or
  the product.

## Labels

- **Buttons are verb-first and name the object:** "Create scope", "Revoke token", "Run now". A bare
  "Delete" or "Save" is allowed only inside a section whose heading already names the object.
- **Fixed verbs.** Create (something new), Delete (gone for good), Remove (taken out of a container,
  still exists elsewhere), Revoke (a credential or access stops working), Cancel (stop a pending
  action that hasn't taken effect), Rename, Invite, Leave. Don't use mint, issue, register,
  administrate or provision in a label.
- **A button reports its own outcome:** "Saving…" then "Saved". The label in progress uses the
  ellipsis character (…), never three dots.
- **Links name where they go:** "Return home", "View billing and usage". Never "Click here" or a
  bare "Return".

## Forms

- **Labels are short nouns:** "Name", "Email", "Role". Mark the exception, not the rule: "Label
  (optional)".
- **Placeholders show an example or the choice to make, never the label again.** Selects read
  "Choose a scope…"; free text reads "e.g. production". A placeholder never carries an instruction
  the builder needs after typing.
- **Hints are full sentences with a period**, placed under the field: "Enter DELETE to confirm."
- **Validation is an instruction, not a verdict:** "Name the automation", "Start the name with a
  letter". Never "Invalid name".

## Empty states

- **Title:** "No {things} yet" whenever the builder can create one. Drop "yet" only when they can't:
  "No invoices". A first-run list the builder must fill to get started may invite instead: "Your
  first device goes here".
- **Body:** one sentence saying what the thing is or what happens first, then the action that fills
  it. "An automation watches for something happening and does something about it." Under "Your first
  device goes here": "Create it, then connect it with the code you're given."
- Use the shared empty-state component, not a bare line of text.

## Errors

- **Say what happened, then what to do next.** "The run could not be started. Try again." If the
  builder can't fix it, say who can: "Ask an owner or manager to set one up."
- **Never show a raw API message.** An API error is a stable code plus a lowercase, developer-facing
  message. The UI maps the code to its own sentence, and falls back to a generic message for a code
  it doesn't know. Status codes, field paths and stack text never reach the screen.
- **The API's own messages follow the code rules** (lowercase, no trailing punctuation, name what
  failed), because the CLI, MCP and SDKs show them verbatim. A message that is wrong for a builder
  in the CLI is wrong in the API.
- **No dead ends.** "Something went wrong" is never complete on its own. Add what the builder can do
  next and a way back.
- **Error alert titles are short past-tense statements:** "Run not started", "Preferences not
  saved". The body is full sentences with periods.

## Destructive actions

- **Friction scales with what is lost.** Losing data or other people's access (deleting an account,
  team, scope or device): a warning that names what goes with it, plus typing DELETE. Losing a
  single credential or membership (revoke a token, remove a member, leave a team), or configuration
  the builder can rebuild (delete an automation or a dashboard): one confirmation that names the
  effect. Reversible actions need none.
- **Name the consequence, not the feeling:** "Deleting this team removes its scopes, devices and
  data." Then "This cannot be undone." once. Never "Please note".
- **The button repeats the verb of the heading:** a "Revoke session" section ends in "Revoke", never
  "Delete".

## Success

- **Prefer the control's own state** ("Saved", "Copied") to a separate message.
- **A standalone success message is a plain statement:** "Your subscription is active." No
  exclamation marks, no thanks, no "Successfully".
- **Shown-once secrets say so plainly:** "Copy this token now. It won't be shown again."

## Transactional email

- **Subject:** a sentence-case statement about the reader's account, no brackets or tags: "Verify
  your email", "Your plan will be downgraded soon", "{automation name} sent a notification".
- **One CTA, verb-first, landing on a page that exists:** "Review invite". Don't link to a surface
  the product doesn't have.
- **Greeting:** "Hi {name}," when a name is known, otherwise no greeting.
- **Story fixtures use production's subject and copy.** A fixture that disagrees with what ships is
  a bug.

## UI, CLI and MCP

The same action reads the same on every surface (brand: human and agent surfaces never diverge).

- **Same nouns and verbs.** If the UI says "claim code", the CLI and MCP say "claim code". An
  object's name doesn't change by surface.
- **Form follows the surface; words don't.** The UI button "Revoke token", the CLI's
  `api token abc123 revoked` and the MCP tool "Revoke an API token." share the verb and the noun.
- **Acronyms are uppercase in prose and labels:** "API token", never "api token". Lowercase is only
  for literal identifiers: commands, flags, codes.
