# Design system

Pipoca's web UI is built from the tokens in `packages/ui/web/theme.css` and the components in `@pipoca/ui`. Plugins get the same tokens and components, so a plugin page looks like the rest of the app. This page is the reference for both. [ADR 0042](adr/0042-pipoca.md) sets the identity, and [ADR 0020](adr/0020-web-stack.md) sets the stack.

## Principles

- **Quiet by default.** Ink and Ivory carry the interface. Colour is for state, and Butter only shows in the mark.
- **Ask in place.** A choice is a chip in the composer or a switch on its row. It isn't a form. Settings save when they change ([ADR 0040](adr/0040-fewer-forms.md)).
- **Keyboard first, touch friendly.** Every control can be reached with Tab and shows a focus ring. On a touch screen, buttons grow to 44px.
- **One way to do each thing.** Use a component from `@pipoca/ui` before writing classes. If two pages need the same thing, it moves into `@pipoca/ui`.
- **Motion explains, never decorates.** Popovers pop in, pages rise in, and nothing loops except a working state. Reduced motion turns all of it off.

## Colour

Every colour is a CSS variable, set for a theme by `data-theme` on any element. Use the Tailwind names, never a hex value.

| Token                               | Light                   | Dark                  | Use                                   |
| ----------------------------------- | ----------------------- | --------------------- | ------------------------------------- |
| `bg`                                | Ivory `#faf7f0`         | `#14120e`             | Page                                  |
| `panel`                             | `#f3efe5`               | `#1a1814`             | Sidebar and chrome                    |
| `elevated`                          | `#fffdf8`               | `#221f1a`             | Cards, inputs, popovers, dialogs      |
| `hover`                             | `#ebe6da`               | `#2a2721`             | Hovered and current rows              |
| `line` / `line-strong`              | `#e3ddd0` / `#cbc3b3`   | `#322e27` / `#454037` | Borders, then hovered borders         |
| `line-focus`, `focus`               | ink tints               | puff tints            | A focused field's border and its ring |
| `fg` / `fg-strong` / `fg-dim`       | Ink                     | Puff                  | Text, headings, secondary text        |
| `accent` / `on-accent`              | Ink / Ivory             | Puff / Ink            | Primary buttons, selection, links     |
| `working` `waiting` `done` `failed` | teal, amber, green, red | lighter tints         | Session and runner states only        |

The four state colours mean the same thing everywhere and are never used for decoration. `butter` only shows in the mark, since it sits between amber and red. `scrim` dims the page behind a dialog or drawer, and `--ansi-0` to `--ansi-15` colour terminal output.

## Type

| Class           | Size          | Use                                          |
| --------------- | ------------- | -------------------------------------------- |
| `text-hero`     | 40px, serif   | The home question, one per screen            |
| `text-wordmark` | 22px, serif   | `pipoca` next to the mark                    |
| `text-display`  | 28px          | Page titles; serif light for welcome screens |
| `text-title`    | 16px semibold | Section headings                             |
| `text-prose`    | 15px / 24px   | Chat messages and the composer               |
| `text-ui`       | 14px          | Controls and rows                            |
| `text-label`    | 13px          | Field labels, chips                          |
| `text-caption`  | 12px          | Hints, metadata, badges, group labels        |
| `text-mono`     | 13px mono     | Code, paths, commands                        |

Hanken Grotesk is the interface face, Newsreader Light (`font-serif`) is for the wordmark and the few large questions, and JetBrains Mono is for code. Headings and labels are in sentence case. Don't use uppercase or letter-spaced labels.

## Shape, depth and motion

- **Radius:** `rounded-sm` 6px for keys and tags, `rounded-md` 9px for buttons and fields, `rounded-lg` 14px for cards and popovers, `rounded-xl` 20px for composers and dialogs, and `rounded-full` for chips, switches and avatars.
- **Depth:** `shadow-xs` lifts a card or button off the page, `shadow-card` is for a composer or a welcome card, and `shadow-pop` is for a popover, menu or dialog. Nothing else casts a shadow.
- **Motion:** `animate-pop-in` (160ms) for popovers and dialogs, `animate-rise-in` (220ms) for a page or empty state, and `animate-fade-in` for overlays. Transitions run for 150ms on `ease-(--ease-out)`. `prefers-reduced-motion` turns them all off.
- **Width:** chat is `max-w-chat` (760px), settings and other pages are `max-w-form` (768px), and the sidebar is 288px.

## Components

| Component                                               | Use                                                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `buttonClass`                                 | `primary` for the one main action on a screen, `default` for others, `ghost` in toolbars, `danger` to delete and `link` inside a sentence. Presses scale to 97%.                        |
| `Field`                                                 | A label above, the control, an optional `hint` below and an `error` in its place.                                                                                                       |
| `TextInput`, `TextArea`, `Checkbox`, `Radio`            | Fields drawn the same way everywhere. Checkbox and Radio take a label and a description.                                                                                                |
| `Picker`                                                | A chip that opens a searchable list, for folders, models, Environments and Profiles. `quiet` draws it as plain text in a composer. `openGroups` folds the other groups to one row each. |
| `Select`                                                | The browser's select drawn as a field, for short fixed lists in settings. Never a bare select.                                                                                          |
| `Slider`                                                | A row of stops moved with arrow keys or a click, for an ordered choice such as the reasoning level.                                                                                     |
| `Switch`                                                | An on/off setting that saves when flipped.                                                                                                                                              |
| `FileButton`                                            | A button that opens the file chooser, or an icon (`iconOnly`) in a composer. Never a bare file input.                                                                                   |
| `ListInput`                                             | A short list of values as chips, added with Enter.                                                                                                                                      |
| `KeyValues`                                             | Variables and secrets.                                                                                                                                                                  |
| `Badge`                                                 | A state, with a dot. Only the four state colours plus `offline`. Without `state` it's a plain pill, such as Optional or Admin.                                                          |
| `StatusMark`                                            | A step's or a Session's state as a small icon: running, done, failed, stopped or pending.                                                                                               |
| `StatusDot`                                             | A small dot for a state beside a name, such as a thread or an Environment.                                                                                                              |
| `Avatar`, `initialsOf`, `plural`                        | A person's or a thing's initials in a circle or square, and counted nouns.                                                                                                              |
| `Card`, `cardClass`, `linkCardClass`, `raisedCardClass` | Grouped content on a page. `raised` for a welcome form, `linkCardClass` for a card that opens something. Never write the classes by hand.                                               |
| `Page`, `Section`                                       | The page column with its heading, description and actions, and its sections. A Page inside another draws only its heading and content.                                                  |
| `AreaLayout`                                            | An area with its own side nav: Settings, the Team hub and Team setup. On a phone the nav becomes a menu page or a bar.                                                                  |
| `Rows`, `Row`                                           | A card of rows, each a setting or an item with its controls on the right, as Settings draws them.                                                                                       |
| `SessionRow`                                            | A Session in a list, with its state, title, meta and actions.                                                                                                                           |
| `Table`, `Cell`                                         | Rows of people or invites with columns.                                                                                                                                                 |
| `Tabs`                                                  | Links between sibling pages, or a tablist when it switches in place.                                                                                                                    |
| `SidePanel`                                             | A panel over the right edge that leaves the page usable, such as a Session's changes.                                                                                                   |
| `Segmented`                                             | A choice between two to four options, all in view, such as the theme.                                                                                                                   |
| `ChoiceCard`, `ChoiceTiles`                             | Larger choices with a description, such as where Pi works or which provider to sign in with.                                                                                            |
| `Stepper`, `Step`                                       | Numbered steps joined by a line, done, current or next.                                                                                                                                 |
| `SetupShell`, `Hero`, `Mark`, `Wordmark`                | The welcome and setup screens: the wordmark, step bars and a serif hero.                                                                                                                |
| `Dialog`, `useConfirm`                                  | A modal on the `scrim`, sized `sm`, `md` or `lg`, or a sheet on a phone. `useConfirm` replaces `confirm()`. Never a bare dialog.                                                        |
| `Menu`, `popClass`                                      | A button that opens a list of actions, such as a Session's menu.                                                                                                                        |
| `Code`, `Command`, `CopyButton`                         | Inline paths and values, and a command to copy and run.                                                                                                                                 |
| `ErrorText`                                             | Why something failed, next to the control. Renders nothing without an error.                                                                                                            |
| `Notice`, `EmptyState`, `Spinner`                       | A tinted message with one action, an empty list with its first action, and something on its way.                                                                                        |
| `Icon`                                                  | Lucide paths at 1.75 stroke. 16px in controls and 14px in chips.                                                                                                                        |

Screens in `apps/web` and `plugins/*/web` build from these. Lint stops a hand-written card class, `bg-black`, a hex colour, `uppercase` and a bare select, dialog or file input there.

## Inputs

Every new input follows these patterns, and older screens move over as they're touched. They're the patterns Claude's own apps use:

- **A quiet resting state.** A field is `elevated` with a `line` border. Hovering darkens the border, and focus adds a 4px `focus` ring. It never turns solid black.
- **Grow with the text.** Every textarea grows with what is typed, between a minimum and a maximum height (a base style in `style.css`; composers set their own heights). Nobody should have to drag a resize handle.
- **Enter sends, Shift+Enter makes a new line.** On a phone, Enter makes a new line and the Send button sends. The hint under the composer says which keys do what.
- **Chips, not forms.** The composer's chips pick where a Session runs, its branch and its model. Each one remembers the last choice.
- **Paste and drop.** Images can be pasted or dropped into a Session's composer.
- **`/` and `@` complete.** Commands and files show in a menu above the composer, which works with the arrow keys, Enter and Escape.
- **Save on change.** Switches, pickers and list inputs save at once. A form with a Save button is only for text that needs to be finished first.
- **Say why, in place.** A disabled control says why in its title. A failed save shows its error next to the control. Nothing fails silently.
- **Use the browser's help.** Set `autoComplete`, `type`, `inputMode` and `required` correctly, so password managers, phone keyboards and validation all work.

## Writing

- Labels name the thing ("Folder or repository"), and buttons say what happens ("Start session").
- Each description is one sentence about what something is for. It doesn't explain how the code works.
- Empty states say what goes there and how to add the first one.
- Use "Session", "Project", "Environment" and "Profile" as names, capitalised, as in [Concepts](get-started/concepts.md).

## Plugins

A plugin's web part imports `@pipoca/ui` and uses only these classes and components. The page only builds the Tailwind classes the app itself uses, so a class that appears nowhere else won't work. Colours come from tokens, so a plugin follows the theme, including a future one that a Profile picks.
