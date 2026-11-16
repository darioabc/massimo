# Mobile: iOS and Android

How massimo reads an iOS or Android app's design values and writes tokens back to Swift, an asset catalog, Jetpack Compose and Android resources. The platform model and its config keys are in `<plugin>/reference/project.md` → Platforms. Mobile support is a preview: tokens in and out, and a read-only count of hard-coded colours. The component graph, previews, the audit's ratchet and tidy read web code only for now.

## What massimo reads

- **An asset catalog** (`tokens.mobileSources`, kind `xcassets`): every colour set, read as Xcode writes it. A colour set's name is the token's path under `color`, with each folder that provides a namespace as a step (`Brand/Primary` is `color.Brand.Primary`), and the name itself is kept in `$extensions.massimo.mobile.asset`, so the outputs write it back unchanged. The light entry (or the any-appearance one) is the value and the dark entry is the dark mode. Components may be 8-bit hex (`0x62`), 8-bit integers (`98`) or floats (`0.384`), in sRGB, extended sRGB or Display P3; the token keeps the form, so a colour set builds back byte for byte. One idiom is read: the universal entries, else the iPhone ones, else the first idiom there is; the notes name the idioms left. A system colour and an empty colour set (a fresh AccentColor) are named in the notes too.
- **Android res/values** (`tokens.mobileSources`, kind `android-values`): `<color>` and `<dimen>` in `values/` and `values-night/` (the dark mode). An Android colour is alpha first: `#80FF0000` is red at 50%. `@color/` and `@dimen/` references become token references; `@android:color/white`, `black` and `transparent` are read; a theme attribute (`?attr/`), a size in px, pt, mm or in, and every other qualifier (`values-v31`, `values-land`, `values-sw600dp`) are named in the notes. A colour is `color.<name>`; a dimension is `<group>.<name>`, its group read from its name (spacing, radius, elevation, size) or `text` for an sp size.
- **Colour literals in Swift and Kotlin**, counted and never changed: `Color(red:…)`, `UIColor(white:…)`, `#colorLiteral`, `Color(hex: "#…")`; `Color(0xFF…)`, `Color(0.1f, …)`, `Color.parseColor("#…")`, `"#…".toColorInt()`. Comments, strings, tests and the files massimo writes are left out. `detect.mjs` reports the count per platform and `audit.mjs` lists it in `latest.md`, read only: no baseline, no `--check`.

## Where colours come from: catalog mode and tokens mode

`tokens.mobile.colors` decides which file is the colour source on iOS.

- **Catalog mode** (`catalog`, the default when `tokens.mobileSources` lists a catalog): the app's catalog stays the source. The Swift output reads each colour from it by name, so the catalog keeps its appearances, high contrast included, and Xcode's own asset symbols keep working. A colour token that is not a colour set in the catalog is not written, and the build says so. An xcassets output in catalog mode is refused, since it would hold every name twice.
- **Tokens mode** (`tokens`, for a monorepo or a new app): the token set is the source. The xcassets output writes a catalog massimo owns, with one colour set per colour and a dark appearance where it changes, and the Swift output reads that. A colour whose colour set in the app's catalog has high-contrast entries is skipped: it stays in the app's catalog as it is, the rest build, and the build lists it. The Swift output still reads it by name. When the owned catalog holds a name the app's catalog also has, Xcode builds both but warns that the name is used by more than one colour set, and which one wins is not defined; the build lists those duplicates, and after the user's OK `tokens.mjs build --dedupe` removes them from the app's catalog so each name exists once.

Android has one mode: the token set builds into massimo's own resource files and the Compose file, beside the app's own `colors.xml`.

## What massimo writes

Every file opens with massimo's header and `massimo mobile output, format 1` (in XML, after the `<?xml ?>` declaration). A `Contents.json` cannot hold a comment, so its `info.author` is `massimo`. Every file a build writes is listed in `<project>/tokens/mobile-outputs.json`; a build never writes over a file that is not, and `check` fails on one it no longer makes until `build --prune`.

- **swift**: one file, an enum per group under `tokens.mobile.namespace` (`DesignTokens.Colors.brandPrimary`, `DesignTokens.Spacing.md`). Inside a Swift package target, declarations are `public` and colours read `bundle: .module`; elsewhere they read the bundle that holds the file, so the file works in an app or a framework target. Text styles, shadows and borders are small `Sendable` structs. `tokens.mobile.uikit` adds `UIColor` twins. With no catalog to read, a colour is built from its components, with a trait-based `UIColor` provider for dark mode.
- **xcassets**: the owned catalog, in tokens mode (above).
- **compose**: one Kotlin file in `tokens.mobile.package`, or the package its path names under `kotlin/` or `java/`. Colours are a data class with a light and a dark instance, a `staticCompositionLocalOf`, a `<Namespace>Theme` composable that picks one with `isSystemInDarkTheme()`, and `<Namespace>.colors` to read them; every other group is an object of values. Every declaration says `public` and its type, so it compiles in a module built in Kotlin's explicit API mode. A Material 3 `ColorScheme` (light and dark) is written only for colours whose names are exactly a Material slot (`primary`, `onPrimary`, `surfaceContainerHigh`…); no role is guessed.
- **android-xml**: `values/massimo_tokens.xml` and, when a colour changes at night, `values-night/massimo_tokens.xml`, in the res folder the output names. Never the app's own `colors.xml` or `dimens.xml`. Before anything is written, each name is checked against every `res/values*/` file of the module: a name the module already declares for the same type stops the build with a list, since it would not compile.

## Wiring an output in

The build prints the step each output needs, once:

- A file in a Swift package target, a Tuist or XcodeGen project, or a folder Xcode keeps in sync is picked up by itself (regenerate a Tuist or XcodeGen project).
- A plain `.xcodeproj`: add the file (and an owned catalog) to the app's target in Xcode, once. massimo never edits `project.pbxproj`.
- Gradle compiles everything under a module's `src/main`; the Compose file needs the module to depend on the Compose libraries it imports (runtime, ui, foundation; animation for curves, material3 for a colour scheme), which a Compose module usually does.

## Units

These are conventions, as Style Dictionary's transform groups use them, not part of the W3C format; each can be changed in `tokens.mobile`.

- A px is one point on iOS and one dp on Android; a rem is `remBase` of them (16).
- A font size is points on iOS (scaled with Dynamic Type, below) and sp on Android (`fontUnit`). A size in the Typography group is sp in Compose and Android resources.
- A duration is seconds in Swift (`TimeInterval`) and milliseconds in Kotlin and Android resources (`Int`, `<integer>`).
- A line height that is a number multiplies the font size; letter spacing in em multiplies it too.
- A length in em follows the font size it sits in and has no fixed value, so the format keeps it only in `$extensions.massimo.css`: the web outputs write that CSS, and the mobile outputs use the token's value, with a note.

## Type and Dynamic Type

A DTCG typography token carries no text style, and a fixed size does not grow with the user's text size. So the Swift output writes a typography token only when it has an iOS text style to scale with: `tokens.mobile.textStyles` maps a token path to one (`largeTitle`, `title`, `title2`, `title3`, `headline`, `subheadline`, `body`, `callout`, `footnote`, `caption`, `caption2`), else a token named like one (`text.body`, `type.caption-2`) takes it. `"fixed"` writes a fixed size on purpose. Any other typography token is not written, and the build says so.

A named family is written with `Font.custom(_:size:relativeTo:)`, and must be bundled with the app and registered. `system-ui`, `-apple-system`, SF Pro and `sans-serif` are the system font, which takes the size of its text style and scales with it; the token's size is kept beside it for layout. A generic family is the system font in a design, with nothing to bundle: `ui-monospace` and `monospace` are `.monospaced` in Swift and `FontFamily.Monospace` in Compose, `ui-serif` and `serif` are `.serif` and `FontFamily.Serif`, and `ui-rounded` is `.rounded` in Swift and `FontFamily.Default` in Compose, which has no rounded system font. On Android, Roboto and the system font are `FontFamily.Default`; any other family is written as `FontFamily.Default` with a note to add it as a font resource. Android resources carry a text style's size and line height only.

## Modes, dark and dynamic colour

The default mode is light and `dark` is dark, on both platforms: an asset catalog's dark appearance, a trait-based provider, the Compose dark instance and `values-night/`. A token with a dark value has it in every mobile output. Only colours change with the appearance on a phone, so a dark value on any other token, and every mode other than the default and dark, is not carried over, and the build says so.

Material 3 apps usually switch to `dynamicLightColorScheme` and `dynamicDarkColorScheme` on Android 12 and later, with a static scheme as the fallback. The compose output writes only the static schemes and leaves the app's switch as it is.

## What is not carried over

The build lists each token it leaves out of an output, and why: a transition (use its duration and curve tokens), a stroke style on its own, a CSS-only value, a typography token with no text style (Swift), and on Android resources anything but colours, sizes, numbers and durations (the compose output carries those). A shadow's spread and inset have no SwiftUI form, a gradient keeps its stops but not a direction, and a stroke style other than solid or dashed is written as solid; each is a note. A colour outside the space an output holds is converted: Display P3 stays Display P3 in Swift, the catalog and Compose, and Android resources and an oklch value become sRGB. Swift and the catalog keep an sRGB colour outside 0 to 1 as extended sRGB; Compose and Android resources clip it, and the note says so.

## Names

Swift and Kotlin names are the token's path without its group, in lowerCamelCase (`color.brand.primary` is `brandPrimary` in `Colors`). Every colour is declared in `Colors`, so a colour under another group keeps that group's word (`text.primary` is `textPrimary`, beside `border.primary` as `borderPrimary`), and a token under `color` that is not a colour goes in the group of its type, keeping the word `color` (`color.disabled-alpha`, a number, is `colorDisabledAlpha` in `Numbers`). A name that starts with a digit takes the group's word in front (`spacing.2` is `spacing2`), and a reserved word takes it after (`color.default` is `defaultColor`); the build lists each rename. A colour set is named as the catalog it came from named it, else the path without `color`, each step PascalCase and every folder a namespace (`Brand/Primary`). An Android resource is the whole path in snake_case, group included (`color_brand_primary`), so it rarely meets a name the app already uses. Two tokens that would share a name stop the build with both named.

Figma variables gain iOS and Android code syntax (`DesignTokens.Colors.brandPrimary`, `DesignTokens.colors.brandPrimary`) once the config declares those platforms.
