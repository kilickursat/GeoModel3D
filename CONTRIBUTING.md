# Contributing to GeoModel3D

Thank you for helping. GeoModel3D is open source under the [Apache-2.0 licence](LICENSE), and contributions of every size are welcome: a bug report, a corrected sentence, a test, a file format, a calculation or an openly licensed dataset.

## Ways to contribute

- **Report a bug.** [Open an issue](https://github.com/kilickursat/GeoModel3D/issues/new/choose) with the version shown next to the title in the app, your browser and system, what you did, what you expected and what happened. A small file that shows the problem helps most; remove anything confidential from it first.
- **Ask for a feature.** Describe the task it serves (for example "earth pressures on an embedded wall") and, for a calculation, the method and a reference: a standard, a textbook or a paper.
- **Improve the documentation:** the README, the CSV templates in [`docs/templates/`](docs/templates/) and the help texts in the app.
- **Contribute code.** For anything larger than a small fix, open an issue first, so that the approach is agreed before you spend time on it. The [roadmap](README.md#roadmap) lists what is planned.
- **Propose a public site or a data source,** following the [rules for data](#data-sites-and-test-fixtures) below.

## Setting up

You need git and Node.js 20.19 or later (CI uses Node 22).

```sh
git clone https://github.com/<your-account>/GeoModel3D.git   # your fork
cd GeoModel3D
npm ci
npm test         # unit tests (vitest)
npm run build    # type-check, then build dist/ and dist/geomodel3d-offline.html
npm run dev      # Vite's development server, where you can run one
```

Where a local server cannot be used, build and open `dist/geomodel3d-offline.html` from disk: it is the whole app in one file.

The modelling kernel (`src/model.ts`, `src/fields.ts`, `src/io.ts` and the other modules that do not render) has no browser dependencies and is tested in Node. The viewer (`src/main.ts`) and the Input data tab (`src/input.ts`) are thin layers on top. The [Architecture](README.md#architecture) section of the README lists every module.

## Making a change

1. Fork the repository and create a branch from `main`, named for the change: `fix/collar-notes`, `feat/cpt-import`, `docs/templates`.
2. Keep a pull request to one topic. Small pull requests are reviewed sooner.
3. Add or update tests in `tests/` for any change to the kernel, the importers or the calculations. Calculations are tested against hand calculations or published examples.
4. Run `npm test` and `npm run build`. Both run on every pull request and must pass.
5. When the app's behaviour changes, update the README, and add a line to `CHANGELOG.md` under an **Unreleased** heading.
6. Sign off your commits with `git commit -s`. The sign-off certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it under the project's licence.
7. Open the pull request against `main`. Say what changed and why, and how you checked it; for anything visible, name the browser and the dataset, and add a screenshot.

By contributing, you agree that your contribution is licensed under Apache-2.0, like the rest of the project.

## How the code is written

- **TypeScript, in the style around it.** Match the naming, the compact layout and the comment density of the file you are editing. Comments say why, in full sentences.
- **No new runtime dependencies** without discussing them in an issue first. The app ships as a static site and as a single offline HTML file.
- **Privacy.** Files that users import and data they type stay in their browser and are never uploaded. A user's own project requests nothing from the network, not even terrain or map tiles, until the user asks for it.
- **Calculations.** Name the method and its assumptions where the result is shown (in the app's notes) and in the README, with a reference. Never assume a missing parameter silently: either leave the result blank where a unit lacks the parameter and say so, as σ′h is left blank for units without K0, or use a stated default and report it, as the unit weights do.
- **Text in the app** is short, plain English, with the symbols and units used elsewhere in the app (σ′v, kPa, m).

## Data, sites and test fixtures

GeoModel3D includes real data only when there is no doubt that it may be shared. For any data added to the repository, as a reference site or as a test fixture:

- **The licence must allow redistribution,** such as CC0, CC BY or an open government licence. Link the licence terms in the pull request.
- **Credit the source** as the licence asks, in the README's [Data sources](README.md#data-sources) and in the dataset's `source` field, and say what was changed.
- **No personal data.** Leave out the names, signatures, registration numbers, telephone numbers and e-mail addresses of people, and the details of owners. Scripts must not read such fields.
- **No access workarounds.** Use only data offered for download or through a documented service. Do not scrape sites that refuse automated access, and do not work around logins, rate limits or terms of use.
- **When in doubt, leave it out.** No site is worth a licence or privacy problem.
- **Reproducible.** Add the script in `scripts/` that builds the dataset from the published files. Keep downloads in the git-ignored `.cache/` folder, never in the repository.

## Reporting a security problem

Please do not open a public issue for a security problem. Write to the maintainer at [kilic_kursat@hotmail.com](mailto:kilic_kursat@hotmail.com) instead.

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Sponsoring

To sponsor GeoModel3D, see [Sponsoring](README.md#sponsoring) in the README.
