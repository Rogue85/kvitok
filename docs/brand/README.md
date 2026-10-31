# Brand

The logo is the word **kvitok**, nothing next to it. Where the word does not fit (favicon, app icon, avatars), the icon is the letter **k** on an orange tile.

| File | Use |
| --- | --- |
| `kvitok-wordmark.svg` | the logo on light backgrounds |
| `kvitok-wordmark-light.svg` | the logo on dark backgrounds |
| `kvitok-icon.svg` | the icon; the same drawing is `apps/web/public/favicon.svg` |

In the web app the logo is `AppLogo` (takes the text color) and the icon is `AppMark`.

Both are outlined from [Unbounded](https://fonts.google.com/specimen/Unbounded) (SIL Open Font License): the wordmark in 600 with −3% tracking, the k in 700. The interface font is [Onest](https://fonts.google.com/specimen/Onest).

## Colors

| Name | Value | Use |
| --- | --- | --- |
| Brand | `#F2551D` (`brand-500`) | the icon, accents, graphics |
| Button | `#C93C0C` (`brand-600`) | `primary` in the light theme: white text on it keeps 5:1 |
| Ink | `#17161C` | the logo on light backgrounds, text |
| Paper | `#F6F4F0` | the logo on dark backgrounds |
| Agent | `#8B5CF6` → `#3B82F6` → `#EC4899` | only what the AI agent does (`.ai-*` in `main.css`) |

Orange marks the brand and what people do, the violet-blue gradient marks what the agent does, so the author of an action is visible by color. Neutrals are Tailwind `stone`.
