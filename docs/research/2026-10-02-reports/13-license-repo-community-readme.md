# ByteBureau — Research cluster 13: Licensing, GitHub repo & community setup, repo security posture, README/docs

Research date: 2026-10-02. Method: direct reads of primary texts (license templates, GitHub docs and the `github/docs` source repo, EUR-Lex, Czech statutes), GitHub REST/code-search data via `gh`, registry/RDAP probes via `curl`, and structural analysis of 19 downloaded READMEs. The session's WebSearch budget was exhausted by sibling agents before this cluster started, so every claim below comes from a fetched URL or an API call; anything I could not fetch is marked **unverified**. I am not a lawyer; legal statements quote primary texts and should be confirmed with counsel before relying on them.

---

## 1. Executive summary

1. **No license protects an idea.** Copyright protects expression only — US Copyright Office FAQ ("Copyright does not protect ideas, concepts, systems, or methods of doing something"), TRIPS Art. 9.2, EU Software Directive 2009/24/EC Art. 1(2), and the Czech Copyright Act § 2(6) and § 65(2) all say so verbatim. Anyone may re-implement an "AI office" from scratch under any license you pick. What a license *can* do is stop people from taking **your code** to build a competing commercial product (FSL/BUSL/PolyForm) or force them to publish their modifications (AGPL/EUPL). What actually protects the *project* is the **trademark on the name/logo, velocity, community and brand**.
2. **Recommended license: FSL-1.1-MIT (Functional Source License, "Fair Source") for the core app, MIT for the public plugin SDK / client packages, DCO for contributions, plus a written trademark policy.** FSL forbids exactly the thing the owner fears — "making the Software available to others in a commercial product or service that substitutes for the Software … or offers the same or substantially similar functionality" — while permitting all internal use, non-commercial use, modification and contribution, and it irrevocably converts each version to MIT two years after release. It is SPDX-listed (`FSL-1.1-MIT`), used by Sentry, GitButler, PowerSync, Typebot, Pythagora, Chartbrew, Liquibase (2025), Tuist, Sourcebot (13 companies listed on fair.io), and ~2.6k LICENSE files on GitHub mention it. **Cost of this choice (be honest about it):** it is *not* open source (OSI: calling it so is "deception"), GitHub's sidebar shows "License: Other", the OpenSSF Best Practices badge requires a FLOSS license, the GitHub Accelerator requires a "clear open source license", and some contributors/companies will not touch non-OSI code.
3. **Runner-up: AGPL-3.0 (+ optional `ee/` open-core folder, MIT SDK).** OSI-approved, keeps the "open source" label and every ecosystem perk, is the 2024–2025 "return to open source" license (Elastic Aug 2024, Redis 8 May 2025) and the default for VC-backed open-core tools (Plausible, Dub, Twenty, Formbricks, Documenso, Coder). It does **not** stop a competitor from selling a hosted/commercial copy as long as they publish source. If the owner values community size over clone-protection, pick this instead.
4. **Name risk is real:** `github.com/ByteBureau` is a Belgian organization (created 2023-02-21, "Brewing up top-tier code", 0 public repos), `github.com/byte-bureau` is a user since 2026-07-15, `bytebureau.com` has been registered since 2017-12-05 (parked lander; expires 2026-12-05), and a 2020 "ByteBureau" company-presentation repo exists. npm (`bytebureau`, `byte-bureau`, `@bytebureau/*`), crates.io, PyPI, Docker Hub, Homebrew, App Store and the domains `.dev/.app/.ai/.org/.net/.cz` are free. A Belgian software house of the same name is a live EU trademark-opposition risk → run TMview/BOIP/ÚPV searches before investing in the brand. EU trade mark: EUR 850 (one class, electronic) + EUR 50 second class + EUR 150 per further class (Reg. 2017/1001 Annex I); Czech national mark: 5 000 CZK up to three classes (+500 CZK/class) (Act 634/2004 Sb., item 138).
5. **Repo setup:** rulesets (not legacy branch protection) are available on public repos under GitHub Free, including personal accounts; **merge queue is not** — it requires an organization-owned public repo. Recommendation: create an org now (`bytebureau-dev`, `getbytebureau`, `bytebureauhq`, `bytebureau-app` are free; `bytebureau` and `byte-bureau` are taken) and transfer the repo. Do **not** "require signed commits" (it blocks squash merges of any PR with an unsigned commit); require linear history + squash-only + PR-title check + required checks + conversation resolution instead. Full checklist with exact `gh` flags, REST calls and a ruleset JSON in §3.
6. **Release & supply chain:** immutable releases (tag + assets locked, release attestation generated), `actions/attest-build-provenance@v4` + `cosign sign-blob --bundle` (Scorecard's Signed-Releases only counts signature files inside release assets), CycloneDX SBOM, npm trusted publishing (OIDC, npm ≥ 11.5.1, Node ≥ 22.14, provenance badge), OpenSSF Scorecard v2.4.4 badge, zizmor v1.30.1, harden-runner v2.21.1, CodeQL default setup, secret scanning + push protection, Dependabot alerts/security updates + Renovate `config:best-practices` (free Mend app).
7. **Changelog:** `unjs/changelogen` (emoji sections 🚀 🩹 💅 📖 🏡 ✅ …, `--release --push`, `changelogen gh release`) for `CHANGELOG.md` + GitHub Releases; `antfu/changelogithub` if you only want release notes; `release-please` if you prefer a Release-PR flow (section titles are free-form strings — 420 public `release-please-config.json` files use 🚀).
8. **README:** 19 top dev-tool READMEs analysed. Winning pattern: centered `<picture>` dark/light logo → one-line pitch → ≤ 8 badges → language links → hero screenshot/GIF or uploaded `.mp4` (9 824 public README.md files embed `github.com/user-attachments/assets/*.mp4`) → copy-paste install → feature grid → "why" table → architecture (Mermaid is natively rendered) → roadmap → contributing/sponsors/star-history → license. Median length of the sample is ~100–250 lines; TUI/CLI tools with GIF galleries run 350–650 lines. Assets: VHS v0.12.1 (`Output *.gif|*.mp4|*.webm`, themes, `WindowBar`, `MarginFill`, `BorderRadius`), asciinema + agg v1.9.0, gifski v3.0.6, Aseprite CLI (`aseprite -b office.aseprite --scale 2 --save-as hero.gif`), social preview 1280×640 < 1 MB, ≤ 20 topics.
9. **Docs site:** Astro **Starlight 0.42.5** (2026-10-01) on Cloudflare Pages or GitHub Pages — built-in Pagefind search, built-in Czech UI strings, fallback notice for untranslated pages, DocSearch plugin, used by Biome/Sentry/GitHub/OpenAI/Warp. VitePress is still **2.0.0-alpha.20** (1.6.4 stable); Rspress 2.0.23, Fumadocs 16.15.17, Docusaurus 3.10.2 and Nextra 4.6.1 are viable alternatives (details §2.5). ADRs: MADR 4.0.0 in `docs/decisions/`.

---

## 2. Findings per topic (evidence + URLs)

### 2.1 Licenses

#### 2.1.1 What copyright does and does not protect (primary texts)

| Source | Text |
|---|---|
| US Copyright Office FAQ (copyright.gov/help/faq/faq-protect.html) | "Copyright does not protect ideas, concepts, systems, or methods of doing something." |
| TRIPS Art. 9.2 (wto.org) | "Copyright protection shall extend to expressions and not to ideas, procedures, methods of operation or mathematical concepts as such." Art. 10.1: programs are protected as literary works. |
| Directive 2009/24/EC Art. 1(2) (EUR-Lex CELEX:32009L0024) | "Ideas and principles which underlie any element of a computer program, including those which underlie its interfaces, are not protected by copyright under this Directive." |
| Czech Copyright Act 121/2000 Sb. § 2(6) (zakonyprolidi.cz/cs/2000-121) | "Dílem podle tohoto zákona není zejména námět díla sám o sobě, … myšlenka, postup, princip, metoda, objev, vědecká teorie, matematický a obdobný vzorec …" ; § 65(2): "myšlenky a principy, na nichž je založen jakýkoli prvek počítačového programu, … nejsou chráněny". |
| GitHub Open Source Guide — Legal (opensource.guide/legal/) | Without a license a public repo is "all rights reserved"; the ToS only "allows others to view and fork your project". Recommends checking the project name "does not conflict with any existing trademarks". |

Consequence: the "AI office / pixel-art office of coding agents" concept is unprotectable by license. Protection comes from (a) trademark on name/logo (§2.2), (b) licensing restrictions on *copying the code* into competing products, (c) execution speed, community, brand.

#### 2.1.2 License-by-license (texts read)

**FSL 1.1 — Functional Source License (fsl.software; template raw from github.com/getsentry/fsl.software)**
- Verbatim core: "A Permitted Purpose is any purpose other than a Competing Use. A Competing Use means making the Software available to others in a commercial product or service that: 1. substitutes for the Software; 2. substitutes for any other product or service we offer using the Software that exists as of the date we make the Software available; or 3. offers the same or substantially similar functionality as the Software. Permitted Purposes specifically include using the Software: 1. for your internal use and access; 2. for non-commercial education; 3. for non-commercial research; and 4. in connection with professional services that you provide to a licensee using the Software in accordance with these Terms and Conditions."
- "We hereby irrevocably grant you an additional license to use the Software under the MIT license that is effective on the second anniversary of the date we make the Software available." (per version; variants FSL-1.1-MIT and FSL-1.1-ALv2/Apache-2.0).
- Trademarks: "Except for displaying the License Details and identifying us as the origin of the Software, you have no right … to use our trademarks".
- Patents: patent license for permitted purposes; terminates if you sue.
- Sentry's own LICENSE.md (FSL-1.1-Apache-2.0) uses the clause unchanged (diff against template = identical).
- fsl.software FAQ: explicitly "not open source"; "Open Source does not protect against harmful free-riding".
- Sentry announcement 2023-11-17 (blog.sentry.io): created because BUSL's 4-year default and bespoke "Additional Use Grant" made every BUSL unique and hard for compliance teams; FSL fixes the variables; CLA not addressed.
- SPDX: `FSL-1.1-MIT` is on the SPDX License List (spdx.org/licenses/FSL-1.1-MIT.html) → valid in `package.json` `"license"`; not OSI-approved.
- GitHub detection: `gh api repos/getsentry/sentry` → `license.spdx_id = NOASSERTION`, name "Other" (same for n8n, Dub, Formbricks, Twenty, PostHog, Terraform, Redis, Elasticsearch, Zed, Bun, GitButler, Keygen, Outline, Infisical, GitLab, CockroachDB). GitHub's sidebar/`license:` search filter will not recognise FSL.
- Adoption (fair.io/companies, dates as listed): Sentry, GitButler, Keygen, PowerSync, CodeCrafters (2024-08-06), Typebot (2024-09-30), Qlty (2025-01-02, actually BUSL per its LICENSE), Pythagora (2025-01-30), Ayon (2025-04-23 — its ayon-core repo shows Apache-2.0), Chartbrew (2025-05-07), Sourcebot (2025-07-20), Tuist (2025-07-08), Liquibase (2025-09-30). Verified license headers via `gh`: GitButler = FSL-1.1-MIT, PowerSync = FSL-1.1-ALv2, Typebot = FSL-1.1-Apache-2.0, Chartbrew = FSL-1.1-MIT, Pythagora = FSL-1.1-MIT, Liquibase = FSL-1.1-ALv2, Keygen = FCL-1.0-ALv2, Qlty = BUSL-1.1.
- Rough GitHub scale (code search, LICENSE files containing the phrase, includes forks, approximate): "Functional Source License" 2 664; "Business Source License 1.1" 10 960; "Elastic License 2.0" 3 800; "PolyForm Noncommercial" 6 912; "Commons Clause" 3 392; "Sustainable Use License" 828; "PolyForm Shield" 728; "Fair Core License" 128.

**Fair Source (fair.io)** — definition: developers "can read, use, and modify Fair Source software with minimal restrictions" and it "automatically becomes Open Source software, usually after two years" (DOSP). Recognised licenses: FSL (flagship), FCL (Fair Core License — FSL + Elastic-style license-key protection, drafted by Heather Meeker, contributed by Keygen; 2-year conversion to Apache-2.0/MIT), BUSL ("complex", usually four years). Positioned as "complementary to Open Source", not open source. Assets handed over to current stewards in 2024.

**BUSL 1.1 (mariadb.com/bsl11)** — "The Business Source License … is not an Open Source license. However, the Licensed Work will eventually be made available under an Open Source License." Grants copy/modify/redistribute/**non-production** use; production use only via the per-project *Additional Use Grant*; converts on the Change Date or "fourth anniversary of the first publicly available distribution", whichever first; Change License must be GPL-2.0-or-later or compatible. Terraform's current parameters (hashicorp/terraform LICENSE, now "International Business Machines Corporation (IBM)"): production use allowed "provided Your use does not include offering the Licensed Work to third parties on a hosted or embedded basis in order to compete with IBM Corp.'s paid version(s)"; defines "competitive offering", "Product", "Embedded". HashiCorp announced the move from MPL-2.0 on 2023-08-10; OpenTofu (Linux Foundation, MPL-2.0, v1.13.0, backed by Gruntwork/Spacelift/Harness/Env0/Scalr, 180+ contributors) forked because "the BUSL and the additional use grant … are ambiguous".

**Elastic License 2.0 (elastic.co/licensing/elastic-license)** — three limitations only: (1) "You may not provide the software to third parties as a hosted or managed service, where the service provides users with access to any substantial set of the features or functionality of the software"; (2) no circumventing license keys; (3) no removing notices. No conversion. Airbyte uses ELv2. Elastic itself added AGPL-3.0 as an option on 2024-08-29 ("We chose AGPL because we believe it's the best way to pave a path towards more Open Source in the world" — Shay Banon). Elasticsearch is now triple-licensed AGPL-3.0-only / SSPL-1.0 / ELv2.

**SSPL v1 (mongodb.com)** — AGPL + Section 13: if you offer the program "as a service" you must release the "Service Source Code" of everything used to run the service ("management software, user interfaces, … backup software, storage software and hosting software"). OSI (2021-01-19): "fauxpen" source, violates OSD 6; "What a company may not do is claim or imply that software under a license that has not been approved by the Open Source Initiative … is open source software. It's deception." Redis moved SSPL → AGPL-3.0 with Redis 8 (2025-05-01; Rowan Trollope: SSPL "hurt our relationship with the Redis community"; AWS/Google forked Valkey, BSD-3-Clause).

**PolyForm family (polyformproject.org/licenses)** — written by "a group of experienced licensing lawyers and technologists" (Kyle Mitchell / Heather Meeker et al. — authorship **unverified** on the page). Licenses: Noncommercial 1.0.0 ("Any noncommercial purpose is a permitted purpose" — personal, charities, education, public research, government; no commercial use), Perimeter 1.0.1 ("Any purpose is a permitted purpose, except for providing to others any product that competes with the software"), Shield 1.0.0 ("… except for providing any product that competes with the software or any product the licensor or any of its affiliates provides using the software" — i.e. protects the *provider's* products too; "free offerings can compete"), Strict, Internal Use, Small Business, Free Trial, Countdown (schedules a change to other terms). None converts to open source by itself (combine with Countdown). No sublicensing/transfer.

**AGPL-3.0 (gnu.org)** — §13: "if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network … an opportunity to receive the Corresponding Source of your version"; §10: "you may not impose any further restrictions"; §7 allows limited additional permissions/terms. OSI-approved; GitHub detects (`AGPL-3.0`). GitHub repos ≥ 100 stars by license qualifier (2026-10-02): mit 172 536, apache-2.0 59 710, gpl-3.0 31 311, bsd-3-clause 10 020, **agpl-3.0 7 702**, mpl-2.0 2 530, isc 1 517, **eupl-1.2 100**.
- Open-core AGPL pattern (verified LICENSE headers): **Dub** — AGPLv3 except `apps/web/app/(ee)` dirs under `ee/LICENSE.md`; **Twenty** — "mostly licensed under … AGPLv3 … with two qualifications": files marked `/* @license Enterprise */` under commercial license, and `twenty-sdk`, `twenty-client-sdk`, `twenty-ui` under MIT, plus an explicit additional permission that apps built on its public APIs are not subject to AGPL; **Formbricks** — AGPLv3 core, `apps/web/modules/ee` proprietary, `packages/js|android|ios|api` MIT; **Plausible** — AGPL-3.0 (GitHub-detected); **Coder**, **Documenso** — AGPL-3.0. **PostHog** = MIT with `ee/` under `ee/LICENSE`. **Cal.com**: the `calcom/cal.com` repo's root LICENSE is MIT and its README (observed 2026-10-02) says "Cal.diy is fully open source, licensed under the MIT License. Unlike Cal.com's 'Open Core' model, Cal.diy has no commercial/enterprise code" — i.e. the previous AGPL+ee split no longer describes that repo. **Zed**: LICENSE-APACHE + LICENSE-GPL (mixed). **Bun**: MIT (statically links LGPL-2 JavaScriptCore). **opencode** (anomalyco/opencode, 211k stars) and **OpenHands** (89.7k) are MIT; **Biome** Apache-2.0; **Supabase** Apache-2.0; **Appwrite** BSD-3; **Penpot** MPL-2.0.

**EUPL 1.2 (interoperable-europe.ec.europa.eu; OJ 2017-05-19)** — official in 23 EU languages **including Czech (CS)**; "Distribution and/or Communication" covers "making available, online or offline, copies of the Work" (SaaS-style network clause, described by the Commission as mirroring AGPL's approach); Art. 5 copyleft + **compatibility clause** (downstream may be redistributed under GPL-2/3, AGPL-3, OSL, EPL-1.0, CeCILL, MPL-2.0, LGPL-2.1/3, LiLiQ-R/R+, CC-BY-SA-3.0 for non-software); Art. 14/15: governed by the law of the EU member state where the licensor resides (→ Czech law) with jurisdiction at the licensor's seat. OSI-approved (not shown on the page; **unverified via fetch**, widely documented). Adoption outside the EU public sector is tiny (100 repos ≥ 100 stars).

**Commons Clause (commonsclause.com)** — add-on condition removing "the right to Sell the Software" ("provide to third parties, for a fee … a product or service whose value derives, entirely or substantially, from the functionality of the Software"). Its own FAQ: "it is best not to call Commons Clause software 'open source'"; "The open source community says this is a bad idea." Only Redis Graph is cited as an adopter (Redis later moved on).

**n8n Sustainable Use License v1.0 (n8n-io/n8n LICENSE.md)** — "You may use or modify the software only for your own internal business purposes or for non-commercial or personal use. You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes." `.ee.` files need an Enterprise License. "fair-code" (faircode.io) is n8n's umbrella term: "generally free to use … source code openly available … extended by anybody … commercially restricted by its authors"; it lists BUSL, Commons Clause, Confluent Community, ELv2, SSPL and SUL as fair-code. n8n: 206k stars — it works for a funded company with a bespoke license; a new indie project gains nothing from a bespoke text that every compliance team must read.

**Apache-2.0 / MIT + trademark policy** — maximum adoption, OSI label, every ecosystem perk; relies entirely on trademark + velocity. GitHub's guide: MIT "allows anyone to do anything so long as they keep a copy of the license"; Apache-2.0 for patent protection.

#### 2.1.3 Ecosystem consequences of a non-OSI (FSL/BUSL/PolyForm/ELv2) license

| Consequence | Evidence |
|---|---|
| Cannot be called "open source" | OSI OSD §6 ("must not restrict anyone from making use of the program in a specific field of endeavor"); OSI SSPL statement ("It's deception"). Use "Fair Source" / "source-available". |
| GitHub sidebar shows "Other"; `license:` search won't match | `gh api repos/<fsl repo>` → `NOASSERTION`; GitHub docs: Licensee compares to "a short list of known licenses". |
| npm fine | `package.json` `license` accepts SPDX ids; `"SEE LICENSE IN <file>"` for non-SPDX; FSL-1.1-MIT is SPDX-listed. |
| OpenSSF Best Practices badge **not** attainable | Passing criteria: "The software produced by the project MUST be released as FLOSS" (OSI approval only SUGGESTED). FSL is not FLOSS. |
| OpenSSF Scorecard "License" check | Uses the GitHub License API (returns NOASSERTION) "otherwise … its own heuristics" — may score lower (**unverified**). |
| GitHub Sponsors | Docs do not state any license requirement; eligibility is "contributes to an open source project" and residence in a supported region — **Czech Republic is supported**; 0 % fee for personal accounts. Risk: a strictly non-OSS project is a grey zone. |
| GitHub Accelerator | Requires "Clear open source license" and "Open source first project" (2024 cohort page; no 2025/26 info). |
| Contributor willingness | GitHub's guide warns extra paperwork "may be perceived as unfriendly"; non-OSI licenses deter some corporate contributors (qualitative; **no 2026 survey fetched**). |
| Linux distro / Homebrew-core packaging | Typically FOSS-only (**unverified**, policy pages not fetched); ship your own tap/installer. |

#### 2.1.4 CLA vs DCO and relicensing optionality

- **DCO 1.1** (developercertificate.org): contributor certifies origin and right to submit "under the open source license indicated in the file"; enforced with `git commit -s` + the **DCO Probot app** (github.com/apps/dco; repo `dcoapp/app` last push 2026-10-01, 348 stars) — checks every commit has a matching `Signed-off-by`. GitHub's guide: "A simple option to automate enforcement of the DCO on your repository is the DCO Probot." GitHub repos can also set `web_commit_signoff_required: true` (REST `PATCH /repos/{o}/{r}`).
- **CLA tooling**: `contributor-assistant/github-action` (CLA Assistant Lite, v2.6.1, stores signatures in a JSON file, supports `use-dco-flag`) was **archived on 2026-03-23** ("owner lacks bandwidth"; existing releases keep working). `cla-assistant.io` (SAP, hosted, gist-based CLA; repo last push 2024-06-06) still runs. EasyCLA is for LF projects.
- **Why it matters under FSL/AGPL:** inbound = outbound means contributors keep their copyright; the licensor can only grant exceptions (commercial dual licenses) or relicense *their own* code unless a CLA assigns/licenses contributions. FSL already converts to MIT, so "relicensing optionality" matters mainly if you want (a) to sell commercial exceptions or (b) to move to AGPL/MIT *earlier* (that is a loosening, which you can do unilaterally for your own code and nobody objects to). Recommendation: **DCO + an explicit "inbound = outbound" clause in CONTRIBUTING.md; add a CLA only if you plan to sell dual licenses.**

### 2.2 Trademark / name collisions (checked 2026-10-02)

| Namespace | Result |
|---|---|
| npm `bytebureau`, `byte-bureau`, `@bytebureau/core`, `@byte-bureau/core` | not found (free); scope search `scope:bytebureau` → 0 packages; npm users `bytebureau`/`byte-bureau` do not exist. Whether the **npm org** name is reserved cannot be checked unauthenticated (403) — create it immediately. |
| GitHub | **`ByteBureau` = Organization, created 2023-02-21, location Belgium, description "Brewing up top-tier code", 0 public repos** (taken, dormant). **`byte-bureau` = User, created 2026-07-15**, 2 TypeScript repos (`automated-musket-mail`, `ministry-of-truth-uplink`). Repo search: `felipetonietto/byteBureauPresentation` (2020, "a presentation for potential clients of the company"), i.e. another company used the name. Free handles: `bytebureau-dev`, `bytebureau-app`, `getbytebureau`, `bytebureauhq`, `bytebureau-io`, `byte-bureau-dev`. |
| crates.io, PyPI, Docker Hub (org & user), Homebrew formula | all free. |
| Apple App Store (iTunes search API) | no "ByteBureau" app (only "Byte Master", "Byte Calculator", …). Google Play: **unverified** (no public API). |
| Domains (RDAP, followed redirects; 404 = unregistered) | **bytebureau.com registered 2017-12-05, expires 2026-12-05**, serves a parked "/lander" redirect. Free: bytebureau.dev, .app, .ai, .org, .net; byte-bureau.com, .dev; bytebureau.cz, byte-bureau.cz (rdap.nic.cz 404). `.io` results ambiguous (**unverified**). |
| EUIPO / TMview / USPTO | TMview API probe returned empty; EUIPO pages 403 to automated fetch → **manual search required** (TMview https://www.tmdn.org/tmview, EUIPO eSearch plus, BOIP for Benelux — the GitHub org is Belgian, USPTO Trademark Search, ÚPV https://upv.gov.cz). |

Fees (primary texts): Regulation (EU) 2017/1001 Annex I: EUR 850 electronic basic fee (one class), EUR 1 000 paper, EUR 50 second class, EUR 150 each class beyond two; Art. 46 three-month opposition window after publication; Art. 52 ten-year term, renewable. Czech Act 634/2004 Sb. item 138: "Přijetí přihlášky individuální ochranné známky do tří tříd výrobků nebo služeb Kč 5000 … za každou třídu výrobků nebo služeb nad tři třídy Kč 500". Relevant Nice classes for ByteBureau: 9 (software) and 42 (SaaS/software services) → EUTM ≈ EUR 900, Czech ≈ 5 000 CZK.

How indie/OSS projects handle trademark policy:
- **Rust Foundation policy** (rustfoundation.org/policy/rust-trademark-policy/): free to use the name to refer to/describe compatibility, `cargo-foo` subcommand names, community merch for personal use, unmodified marks in publications; permission needed for selling merch, using the marks inside other marks, event names, "distributing substantially modified versions still called Rust". Rationale: so users get "the product produced by the Rust Project".
- **Linux Foundation trademark usage guidelines** (linuxfoundation.org/legal/trademark-usage): nominative fair use OK; no implied endorsement; no use as domain name/product name/company logo; "Open source copyright licenses do not grant trademark rights"; the text is **CC BY 4.0** and inspired by Mozilla/GNOME — safe to adapt.
- Model Trademark Guidelines (modeltrademarkguidelines.org) — site unreachable (TLS mismatch) → **unverified**; the LF text is a fine substitute.
- FSL already contains a no-trademark clause; a separate `TRADEMARK.md` tells forks what they may call themselves (e.g. "a fork of ByteBureau" yes, "ByteBureau Pro" no).

### 2.3 GitHub repository setup (2026 docs)

Current state of `misaon/byte-bureau` (gh, 2026-10-02): created 2026-10-01, public, empty (no default branch), **wiki enabled, projects enabled, discussions disabled, issues enabled, no license, no topics**.

**Plan availability (from `github/docs` source reusables, exact text):**
- Rulesets: "available in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud." Push rulesets: "available for the GitHub Team plan in internal and private repositories" (not needed).
- Protected branches: same as above (legacy; rulesets layer, aggregate "most restrictive wins", support Active/Disabled, bypass lists, tag rulesets, are visible to anyone with read access, up to 75 per repo).
- **Merge queue: "available in any public repository owned by an organization, or in private repositories owned by organizations using GitHub Enterprise Cloud."** → not on a user-owned repo.
- Private vulnerability reporting: "available for public repositories on GitHub.com".
- Discussions: owners can enable on public and private repos (user-owned OK). Default categories: 📣 Announcements, #️⃣ General, 💡 Ideas, 🗳 Polls, 🙏 Q&A, 🙌 Show and tell; formats Open-ended / Q&A / Announcement / Poll; max 25 categories; `.github/DISCUSSION_TEMPLATE/` forms.
- CodeQL default setup: needs Actions enabled and a public repo (free); JS/TS supported; "Settings > Advanced Security > Code security > CodeQL analysis > Set up > Default". Secret scanning + push protection: Settings > Advanced Security > Secret Protection; "secret scanning blocks contributors from pushing secrets to a repository and generates an alert whenever a contributor bypasses the block".
- Copilot code review: "available with Copilot Pro, Copilot Pro+, and Copilot Max plans, and with a Copilot Business or Copilot Enterprise license" (not Free); request via reviewer "Copilot" or `gh pr edit N --add-reviewer @copilot`; automatic reviews via rulesets; honours `.github/copilot-instructions.md` (read from the head branch); est. $0.05–$1 (Lite) / $0.25–$5 (Balanced) of AI credits per review; skips lockfiles/logs/SVG.
- Claude Code GitHub Action `anthropics/claude-code-action@v1` (v1 tag 2025-08-26): modes = `@claude` mentions, automatic PR review via `prompt`, agent mode; auth `ANTHROPIC_API_KEY` or OAuth token; `claude /install-github-app` needs repo admin; permissions `contents: read, pull-requests: write, issues: write`; "Only users with write access can trigger via @claude mentions"; fork PRs need explicit approval.

**Rules available in rulesets (available-rules page):** restrict creations/updates/deletions; require linear history; require deployments; **require signed commits**; require a pull request (0–10 approvals, dismiss stale, code-owner review, last-push approval, conversation resolution, allowed merge methods, extra approval for "unattributed Copilot pull requests", required reviewers from teams); require status checks (strict/loose); block force pushes; require secret-scanning alerts resolved; require code scanning results; require code quality results; metadata restrictions (commit message/author email/branch & tag name patterns — docs flag these as Enterprise Cloud in the source: `{% ifversion ghec %}`); push rules (file paths/extensions/size/path length).

**Signed commits implication (about-protected-branches, verbatim):** "unsigned commits on the head branch can block a squash merge, even though GitHub would sign the final squash commit" and "To merge a blocked pull request, rewrite and sign the unsigned commits on the head branch, or ask someone with permission to bypass". GitHub signs web-UI commits (incl. squash merges) with its own key; rebase merges are "added to the base branch without commit signature verification". → Requiring signed commits forces every drive-by contributor to configure GPG/SSH signing. Recommendation: owner enables SSH signing + **vigilant mode** on his account, repo does *not* require signatures; trust comes from provenance attestations instead.

**Squash + conventional title:** REST `PATCH /repos/{o}/{r}` fields `squash_merge_commit_title: PR_TITLE | COMMIT_OR_PR_TITLE`, `squash_merge_commit_message: PR_BODY | COMMIT_MESSAGES | BLANK`; `gh repo edit --squash-merge-commit-message`. `amannn/action-semantic-pull-request@v6` (v6.1.1, 2025-08-22; used by Electron, Vite, Excalidraw) validates PR titles; recommended trigger `pull_request_target` with `types: [opened, edited, synchronize, reopened]` — safe because it never checks out PR code.

**Community health files (docs):** CODE_OF_CONDUCT.md, CONTRIBUTING.md, ACCESSIBILITY.md, SECURITY.md, SUPPORT.md may live in root, `.github/` or `docs/`; `FUNDING.yml` must be `.github/FUNDING.yml` (keys: `github` up to 4 users, `ko_fi`, `liberapay`, `open_collective`, `patreon`, `polar`, `buy_me_a_coffee`, `thanks_dev` (`u/gh/USER`), `tidelift`, `issuehunt`, `community_bridge`, `custom` up to 4 URLs; the repo's "Sponsorships" feature must be on); issue templates in `.github/ISSUE_TEMPLATE/`; discussion forms in `.github/DISCUSSION_TEMPLATE/`; account-level defaults via a public `.github` repo — "you cannot create a default license file". GOVERNANCE.md is not a GitHub-recognised file (plain doc). CODEOWNERS: first found of `.github/`, root, `docs/`; gitignore-like patterns, `!` negation unsupported, last match wins, owners need write access, 3 MB max; hardening guide: add `.github/workflows` to CODEOWNERS.

**Issue forms (syntax page):** `.github/ISSUE_TEMPLATE/*.yml` with `name`, `description`, `body` (required) + `title`, `labels` (must pre-exist), `assignees`, `projects`, `type`; body elements `markdown`, `input`, `textarea` (optional `render` for code), `dropdown` (single/multiple), `checkboxes`, `upload`; `validations: required: true`. `config.yml`: `blank_issues_enabled: false` (maintainers still get a "Maintainers only" blank option) + `contact_links` (name/url/about). PR templates: `PULL_REQUEST_TEMPLATE.md` in root/docs/.github or multiple in `PULL_REQUEST_TEMPLATE/` via `?template=`.

**Code of conduct:** Contributor Covenant 3.0 (contributor-covenant.org/version/3/0/) — structure: Our Pledge; Encouraged Behaviors; Restricted Behaviors; Reporting an Issue; Addressing and Repairing Harm (Warning → Temporarily Limited Activities → Temporary Suspension → Permanent Ban); licensed CC BY-SA 4.0; fill in the `[NOTE]` placeholders. Version 3.0 content first appeared in the repo on 2025-08-04 (git history; no formal date on the site). **No Czech translation listed** (the translations page lists 40+ languages for 1.4/2.0/2.1/3.0 without cs) → write your own cs version if you want one.

**Moderation:** limit interactions (existing users / prior contributors / collaborators only; 24 h–6 months); cap concurrent PRs from non-write users with a bypass list (up to 100 users); block users; report abuse. 2FA: mandatory for anyone who creates releases, publishes packages/actions, or contributes to high-importance repos (45-day enrollment + 7-day grace); org-wide 2FA requirement exists only for organizations.

**Settings as code:** `github/safe-settings` (3.0.0-rc.1, 2026-10-01) is a self-hosted Probot app for *organizations* with an admin repo — "settings files cannot be in individual repositories" → not practical for one repo. The older Probot **Settings** app (`repository-settings/app`, hosted at github.com/apps/settings, last push 2026-10-01) syncs `.github/settings.yml` (repo settings, labels, milestones, collaborators, branch protection; rulesets not mentioned) but "anyone with push permissions gains effective admin access" → protect `settings.yml` with CODEOWNERS. Alternative: a checked-in `scripts/repo-settings.sh` of `gh` calls (given in §3).

**Automation actions (versions observed 2026-10-02):** actions/stale v11.0.0 (Node 24; defaults 60 days stale / 7 close; use `exempt-labels`, `exempt-all-assignees`, `operations-per-run`), actions/labeler v7.0.0 (`pull_request_target` without checkout; `any-glob-to-any-file`, `head-branch`), release-drafter v7.8.0 (label-driven categories with emoji titles, autolabeler, `$RESOLVED_VERSION`), all-contributors bot v1.19.2 (2024-09-12 release; docs updated 2026-09-30; `@all-contributors please add @user for code, doc`), unjs/changelogen v0.6.2 (2025-07-06; repo active 2026-10-01), antfu/changelogithub v15.0.5, release-please v17.11.2 (action v4; needs "Allow GitHub Actions to create and approve pull requests" or a PAT/App token for CI to run on release PRs; `changelog-sections` / `changelog-types` JSON `[{"type":"feat","section":"🚀 Features"}]`), commitlint v21.2.3, lefthook v2.1.16, husky v9.1.7, changesets 3.0.3, release-it 21.1.0.

**Security actions:** OpenSSF Scorecard action v2.4.4 (`publish_results: true`, needs `id-token: write` + `security-events: write`; push/schedule on default branch only; badge `https://api.scorecard.dev/projects/github.com/OWNER/REPO/badge`; SARIF to code scanning). Scorecard checks worth designing for: Dangerous-Workflow (critical), Token-Permissions (top-level `permissions: read-all`/`contents: read`), Pinned-Dependencies (actions pinned to full SHA; lockfile), Branch-Protection (10/10 needs dismiss-stale + admins included), Signed-Releases (only `*.minisig|*.asc|*.sig|*.sign|*.sigstore|*.sigstore.json|*.intoto.jsonl` **inside release assets**; SLSA provenance file → 10/10), Security-Policy, Dependency-Update-Tool, SAST, CI-Tests, Maintained, Packaging, Vulnerabilities. zizmor v1.30.1 (audits template injection, unpinned actions, cache poisoning, `pull_request_target`, artipacked, secrets-inherit, dangerous triggers; `zizmorcore/zizmor-action`; SARIF). step-security/harden-runner v2.21.1 (egress audit → block; free for public repos; "secure-repo" generates hardening PRs). GitHub hardening guide: pin third-party actions to "a full-length commit SHA" ("the only way to use an action as an immutable release"), default `GITHUB_TOKEN` read-only, no `${{ }}` in `run:` (use env), OIDC instead of long-lived creds, Dependabot for actions. Repo Actions settings: Actions permissions ("Allow OWNER, and select non-OWNER actions and reusable workflows" + "Allow actions created by GitHub" + "Allow Marketplace actions by verified creators"), fork PR approval ("Require approval for first-time contributors who are new to GitHub" / "… for first-time contributors" / "… for all external contributors"), workflow permissions (read-only default), "Allow GitHub Actions to create and approve pull requests", retention 1–90 days (public). Pwn-request guidance (GitHub Security Lab): `pull_request_target` runs with write token + secrets in the base-repo context; never check out and build PR code under it; use `pull_request` for untrusted code and `workflow_run` + artifacts for privileged steps; label gating is a weaker stopgap; `persist-credentials: false` on checkout.

**Supply chain / releases:** Artifact attestations: `actions/attest-build-provenance@v4` (v4.2.2) with `permissions: id-token: write, attestations: write, contents: read` and `subject-path`; SBOM attestation via `actions/attest-sbom`; verify with `gh attestation verify <file> -R owner/repo` (`--predicate-type` for SPDX/CycloneDX). **Immutable releases** (docs concept page): "releases where the assets and associated Git tag cannot be changed after publication"; tag locked to a commit and cannot be deleted while the release exists; assets cannot be modified/deleted; title/notes/pre-release flag remain editable; "creating an immutable release automatically generates a release attestation" (tag, commit SHA, assets); protects against "repository resurrection attacks"; best practice: create draft → attach all assets → publish; enable per repo or org (how-to page: `prevent-release-changes`). Release limits: 2 GiB per file, 1 000 assets. cosign keyless blob signing: `cosign sign-blob --yes --bundle <file>.sigstore.json <file>` (OIDC identity from GitHub Actions) and `cosign verify-blob --bundle … --certificate-identity-regexp … --certificate-oidc-issuer https://token.actions.githubusercontent.com <file>`; `sigstore/cosign-installer@v4` (v4.1.2). SBOM: `@cyclonedx/cyclonedx-npm@6` (v6.0.1; CycloneDX 1.2–1.6, `--omit dev`, `--package-lock-only`; Node ≥ 20.18, **npm lockfiles only — no bun/pnpm; use `syft` or `cyclonedx-node-pnpm` otherwise**). npm trusted publishing (docs.npmjs.com/trusted-publishers): OIDC from GitHub Actions/GitLab/CircleCI cloud runners; configure org/user, repo, workflow filename (+ optional environment) on the package page; workflow needs `permissions: id-token: write`; **npm CLI ≥ 11.5.1 and Node ≥ 22.14.0**; automatic provenance attestation + provenance badge (public repo + public package); up to 10 trusted publishers per package; config immutable (delete & recreate); the package must already exist on npmjs.com (first publish manual). `package.json`: `"license": "FSL-1.1-MIT"`, `"funding"`, `"publishConfig": {"access": "public", "provenance": true}` (provenance flag **unverified** on the fetched page; documented in npm CLI publish docs).

**Dependency updates:** `dependabot.yml` v2 — `package-ecosystem` (`npm`, `github-actions`, `docker`, **`bun` listed in the cooldown table**), `schedule.interval` (daily…yearly/cron), **`cooldown`** ("allowing updates to be delayed for a configurable number of days"), `groups`, `open-pull-requests-limit`, `labels`, `commit-message` (prefix/scope), `ignore`/`allow`, `registries`, `multi-ecosystem-groups`. Renovate: `config:best-practices` = config:recommended + pin GitHub Actions to full SHA digests, pin dev deps, Docker digests, abandonment handling, minimum release age, weekly lock-file maintenance; Mend recommends `minimumReleaseAge: "14 days"` before automerge; Dependency Dashboard; the **Mend Renovate GitHub App is "free to install for both public and private repositories"** (onboarding PR). Dependabot *alerts* and *security updates* stay on regardless (REST: `PUT /repos/{o}/{r}/vulnerability-alerts`, `PUT /repos/{o}/{r}/automated-security-fixes`).

**CLI knobs:** `gh repo edit` flags (manual): `--enable-wiki`, `--enable-projects`, `--enable-discussions`, `--enable-issues`, `--enable-merge-commit`, `--enable-squash-merge`, `--enable-rebase-merge`, `--enable-auto-merge`, `--delete-branch-on-merge`, `--allow-update-branch`, `--squash-merge-commit-message`, `--default-branch`, `--description`, `--homepage`, `--add-topic`/`--remove-topic`, `--enable-secret-scanning`, `--enable-secret-scanning-push-protection`, `--enable-advanced-security`, `--allow-forking` (org repos), `--template`, `--visibility` + `--accept-visibility-change-consequences`. `gh ruleset` has only `list`, `view`, `check` → create rulesets with `gh api -X POST repos/{o}/{r}/rulesets --input ruleset.json`. REST ruleset body: `name`, `target` (branch/tag/push), `enforcement` (active/evaluate/disabled), `bypass_actors[]` (`actor_type` Integration/OrganizationAdmin/RepositoryRole/Team/DeployKey, `bypass_mode` always/pull_request), `conditions.ref_name.include` (`~DEFAULT_BRANCH`, `refs/heads/release/*`), `rules[]` types `creation|update|deletion|required_linear_history|merge_queue|required_deployments|required_signatures|pull_request|required_status_checks|non_fast_forward|commit_message_pattern|commit_author_email_pattern|committer_email_pattern|branch_name_pattern|tag_name_pattern|workflows|code_scanning|file_path_restriction|max_file_path_length|file_extension_restriction|max_file_size`. Other REST: `PUT /repos/{o}/{r}/private-vulnerability-reporting`, `PUT /repos/{o}/{r}/topics` (`names[]`), `PATCH /repos/{o}/{r}` (`has_wiki`, `has_projects`, `has_discussions`, `allow_*_merge`, `delete_branch_on_merge`, `allow_update_branch`, `web_commit_signoff_required`, `security_and_analysis`).

### 2.4 README research

**Sample (README fetched via `gh api repos/X/readme`, 2026-10-02):**

| Repo | Lines | Words | `<picture>` | imgs | shields | GIF | video/mp4 | user-attachments | tables | details | notable |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oven-sh/bun | 446 | 2 062 | 0 | 4 | 3 | 0 | 0 | 1 | 0 | 0 | centered logo, "What is Bun?", multi-OS install, "Quick links", Guides index |
| zed-industries/zed | 48 | 298 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | custom endpoint badge, minimal, links to docs |
| anomalyco/opencode | 129 | 540 | 1 | 4 | 3 | 0 | 0 | 0 | 6 | 0 | dark/light logo, one-liner, **22 language READMEs**, screenshot, install block with 9 package managers |
| biomejs/biome | 198 | 725 | 3 | 14 | 0 (ref-style) | 0 | 0 | 0 | 0 | 0 | dark/light slogan banner, usage snippet, "More about Biome" bold-lead paragraphs, sponsor tiers |
| withastro/astro | 103 | 384 | 0 | 1 | 21 | 0 | 0 | 0 | 26 | 0 | banner.jpg, 21 badges, package directory table, sponsors |
| drizzle-team/drizzle-orm | 44 | 300 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | `#gh-dark-mode-only` logos, 🚀 in h3, link bar |
| tauri-apps/tauri | 96 | 569 | 0 | 2 | 6 | 0 | 0 | 0 | 7 | 0 | splash.png, platform table, partners |
| honojs/hono | 85 | 327 | 0 | 1 | 9 | 0 | 0 | 0 | 0 | 0 | title image, Quick Start, Features bullets, contributors graph |
| sharkdp/hyperfine | 347 | 1 427 | 0 | 0 | 1 | 1 | 0 | 0 | 7 | 0 | demo GIF right under pitch, per-distro install |
| charmbracelet/gum | 487 | 1 718 | 0 | 21 | 1 | 13 | 0 | 0 | 0 | 3 | one GIF per command, `<details>` |
| darrenburns/posting | 60 | 256 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | bold pitch, screenshot, feature bullets, 2-line install |
| jesseduffield/lazygit | 643 | 3 646 | 0 | 7 | 4 | 15 | 0 | 0 | 0 | 0 | sponsor banner, "Elevator Pitch", TOC, GIF per feature |
| ghostty-org/ghostty | 226 | 1 456 | 0 | 1 | 0 | 0 | 0 | 1 | 8 | 0 | logo+h1, pitch, in-page nav links, About/Download/Docs |
| yorukot/superfile | 258 | 670 | 2 | 5 | 6 | 1 | 0 | 0 | 3 | 0 | Ko-fi, dark/light logo, demo.gif table, TOC, **star-history** |
| vitejs/vite | 66 | 238 | 1 | 6 | 6 | 0 | 0 | 0 | 5 | 0 | dark/light logo, "Vite ⚡", packages table, sponsors |
| shadcn-ui/ui | 17 | 58 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | one hero image, three links |
| charmbracelet/vhs | 894 | 3 052 | 23 | 31 | 1 | 77 | 2 | 0 | 0 | 2 | reference-style README; each setting has a GIF |
| All-Hands-AI/OpenHands ("Agent Canvas") | 179 | 1 312 | 0 | 8 | 5 | 0 | 0 | 1 | 14 | 0 | `for-the-badge` badges, 2-column feature table, Quickstart options |
| unjs/nitro (v3 branch) | 20 | 66 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | `> [!NOTE]` branch banner, docs link |

Observations:
- **Length:** libraries/frameworks with external docs: 17–130 lines; apps/CLIs: 130–450; TUI tools with GIF galleries: 350–650+. For ByteBureau target 150–300 lines, push reference material to the docs site, use `<details>` for long install matrices.
- **Hero:** 6/19 use `<picture>` + `prefers-color-scheme` (opencode, biome, vite, superfile, vhs, …) or `#gh-dark-mode-only` (drizzle, vhs). The docs' basic-syntax page confirms "The `<picture>` HTML element is supported."
- **Badges:** typical 3–9; Astro's 21 is the ceiling; OpenHands uses `style=for-the-badge` for a bolder look. Verified-live endpoints (HTTP 200, `image/svg+xml`): `img.shields.io/github/license/O/R`, `/npm/v/PKG`, `/github/v/release/O/R`, `/github/downloads/O/R/total`, `/github/actions/workflow/status/O/R/ci.yml`, `/discord/ID`, `/github/sponsors/USER`, `/github/stars/O/R?style=social`, `/badge/License-FSL--1.1--MIT-blue`, `api.scorecard.dev/projects/github.com/O/R/badge`, `api.star-history.com/svg?repos=O/R&type=Date`, `contrib.rocks/image?repo=O/R`. Socket badge (`socket.dev/api/badge/npm/package/PKG`) returned 403 to curl → **unverified**. Best Practices badge URL pattern `bestpractices.dev/projects/<id>/badge` (needs a project id; not applicable under FSL anyway).
- **Demo media:** GitHub accepts `.mp4/.mov/.webm` uploads (10 MB on a free plan, 100 MB paid; H.264 recommended) and `.png/.gif/.jpg/.svg` (10 MB). GitHub code search finds **9 824 `README.md` files containing `github.com/user-attachments/assets` + `.mp4`** (e.g. Netflix/void-model, hkchengrex/MMAudio) — strong empirical evidence that uploaded videos render inline in READMEs (the docs page only lists issues/PRs/discussions explicitly, so "renders in README" is **verified empirically, not by docs text**). The `<video>` HTML tag itself is sanitised; paste the uploaded asset URL on its own line.
- **Multi-language READMEs:** opencode links 22 `README.xx.md` files in the header (`README.cs.md` fits this pattern); hyperfine links a `中文` translation.
- **Mermaid:** fenced ```` ```mermaid ```` blocks render in Markdown files (flowcharts, sequence, pie, …); GeoJSON/TopoJSON/STL too; theming directives and automatic dark mode: **unverified** (docs page silent) — keep diagrams theme-neutral.
- **Alerts:** `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` render as callouts.
- **Social preview:** 1280×640 px (min 640×320), PNG/JPG/GIF < 1 MB, solid background recommended, Settings → General → Social preview (no API).
- **Topics:** ≤ 20 per repo, lowercase letters/numbers/hyphens, ≤ 50 chars; GitHub suggests topics for public repos; topic pages aid discovery.
- **Terminal demo tooling:** VHS v0.12.1 (2026-09-24): tape files with `Output demo.gif|.mp4|.webm|frames/`, `Set Theme "Catppuccin Frappe"` or JSON theme, `Set WindowBar Colorful`, `Set Margin 20` + `Set MarginFill "#674EFF"`, `Set BorderRadius 10`, `Set Framerate 60`, `Set PlaybackSpeed`, `Set LoopOffset 50%`, `Set TypingSpeed`, `Set FontFamily`; `vhs publish demo.gif` hosts on vhs.charm.sh; usable in CI for golden-file tests. asciinema + agg v1.9.0: asciicast v1–v3 → GIF via gifski, built-in themes (dracula, github-dark/light, nord, …), Nerd Font symbols, colour emoji, idle-time limiting, speed, frame selection. gifski v3.0.6 for high-quality palettes. Aseprite CLI: `aseprite -b office.aseprite --scale 2 --save-as hero.gif` (`--frame-range`, `--split-layers`, `--sheet` + `--data` JSON for sprite sheets). Lottie→GIF pipelines: **not researched**.
- **Linting:** markdownlint (DavidAnson/markdownlint v0.41.1 tag) for README/docs; awesome-lint is for "awesome" lists only.

### 2.5 Docs site

| Tool | Version observed (date) | i18n | Search | Notes |
|---|---|---|---|---|
| **Astro Starlight** | `@astrojs/starlight@0.42.5` (2026-10-01) | `locales` + `defaultLocale`; `root` for unprefixed default; content in `src/content/docs/cs/`; untranslated pages fall back with "This content is not available in your language yet."; **built-in UI strings include Czech**; `Astro.locals.t()` | **Pagefind built-in** (opt-out `pagefind: false`), `@astrojs/starlight-docsearch` for Algolia, Typesense alternative | Markdown/Markdoc/MDX, dark/light, framework-agnostic components; used by OpenAI, GitHub, Netlify, Microsoft, Sentry, Warp, Biome, Knip |
| VitePress | **2.0.0-alpha.20** (2026-09-04); 1.6.4 stable | `locales` with `root` + `/cs/` dirs, per-locale `themeConfig`, `lang`, `dir` | MiniSearch local / Algolia (not re-verified on the fetched page) | Vue/Vite; v2 still alpha as of today |
| Rspress | v2.0.23 (2026-09-29) | native i18n (`/guide/basic/i18n`), multi-version docs, version-specific search | built-in full-text | Rsbuild/Rspack/React, "AI-native SSG-MD + llms.txt", Shiki, lazyCompilation |
| Fumadocs | fumadocs@16.15.17 (2026-09-29) | `defineI18n({ defaultLanguage, languages, hideLocale })`, `npx @fumadocs/cli init --i18n`; "Fumadocs is not a full-powered i18n library, it's up to you when internationalizing the rest of your app" | Orama/Algolia (not re-verified) | React; works with Next.js, React Router, TanStack Start, Waku, Astro+React; OpenAPI integration |
| Docusaurus | v3.10.2 (2026-07-10) | `i18n/<locale>/docusaurus-plugin-content-docs/current`, `docusaurus write-translations`, Crowdin, built-in theme translations | Algolia DocSearch (classic) | React/MDX; heavier config |
| Nextra | nextra-theme-docs@4.6.1 (2025-12-04) | `i18n.locales` in next.config + language dropdown; **locale middleware incompatible with `output: 'export'`** | FlexSearch/Pagefind (not re-verified) | Next.js App Router required; slower release cadence |
| Mintlify | hosted | — | hosted | **Starter tier free** (5 editor seats, custom domain, no credit card); Pro $450/mo; "OSS program" link exists (details **unverified**); not self-hostable |

Search services: **Pagefind 1.5.x** (fully static, chunked index, ~100 kB typical payload, < 300 kB on 10 k pages, multilingual zero-config; Czech stemming **unverified**). **Algolia DocSearch**: free, "Open to developer documentation and technical blogs", public technical docs only, automated + manual review (1–2 business days), verify domain ownership within 7 days, v5 current (docs updated 2026-08-06). Hosting: **GitHub Pages** — 1 GB site, 100 GB/month soft bandwidth, 10 builds/hour soft (not with custom Actions workflow), "not intended for … facilitating commercial transactions"; **Cloudflare Pages** free — 500 builds/month, 1 concurrent build, 20-minute build timeout, 20 000 files, 25 MiB/file, 100 custom domains; **Vercel Hobby** — "the Hobby plan restricts users to non-commercial, personal use only" (100 GB fast data transfer, 100 deployments/day) → avoid for an FSL project that may monetise.

ADRs: **MADR 4.0.0** (2024-09-17; MIT/CC0) — `docs/decisions/NNNN-title-with-dashes.md`; sections Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome, Consequences, Confirmation, Pros and Cons, More Information; "bare"/"minimal"/full variants; "there is currently no tooling supporting MADR 3.0.0" (4.0 likewise); `npryce/adr-tools` last push 2024-04-25 (shell scripts, older template) — a plain template + PR review is enough.

---

## 3. Ranked recommendations + risks

### 3.1 License decision (ranked)

**#1 — FSL-1.1-MIT core + MIT SDK/client packages + DCO + TRADEMARK.md ("Fair Source")**
- Fits the brief literally: visible source (anyone may read, run internally, audit, modify, contribute), *forbids commercial clones/substitutes for two years per version*, standardised text (no bespoke grant), converts to MIT so forks and users are never stranded, trademark clause built in.
- Use `FSL-1.1-MIT` (not ALv2) because the rest of the TypeScript ecosystem is MIT and the eventual license should be the least surprising. Licensor = "Ondřej Misák" (or a future s.r.o. — decide before first release; see open questions).
- Publish the plugin SDK, protocol/types and the phone-remote client under MIT so third-party plugin authors and integrators are unencumbered (Twenty's `twenty-sdk`/`twenty-ui` MIT precedent; Formbricks' client packages).
- Say "Fair Source", "source-available"; never "open source". Add topics `fair-source`, `fsl`.
- Risks: loses OSI-dependent perks (Best Practices badge, Accelerator, some distro packaging, some contributors); "substantially similar functionality" is untested in court and enforcement costs money; GitHub shows "Other"; Sponsors eligibility is a grey zone (no license rule in docs, but the programme is framed around open source).

**#2 — AGPL-3.0 (optionally + `ee/` proprietary folder) + MIT SDK + DCO**
- Choose this if the owner prefers the "open source" label and the largest contributor pool and can live with competitors legally selling/hosting copies as long as they publish their source. Strong precedent (Redis 8, Elastic, Plausible, Dub, Twenty, Formbricks, Documenso, Coder). For a locally-run desktop tool the AGPL network clause bites less than for a server product. Add a Twenty-style additional permission for apps built on the public API.
- Risks: AGPL is blacklisted at some employers (fewer corporate contributors/users); dual-licensing later needs a CLA; still cannot stop a well-funded fork (OpenTofu-style forks are possible under any OSI license).

**#3 — Apache-2.0 (or MIT) + aggressive trademark + speed**
- Maximum adoption; patent grant; what Bun/Biome/Vite/Astro/Hono/opencode/OpenHands do. Pick this if the owner concludes (correctly, legally) that the idea is unprotectable anyway and growth matters most. Protection = brand + community + cadence.
- Risks: a commercial clone is fully legal; only the name/logo is protected.

### 3.2 Exact files to add (license layer)

- `LICENSE.md` — FSL-1.1-MIT template verbatim (from github.com/getsentry/fsl.software, `FSL-1.1-MIT.template.md`), with the "Licensor ("We")" line set to your legal name/entity and "The Software" = "ByteBureau". Keep the file name `LICENSE.md` (Sentry/GitButler convention) so Scorecard finds it.
- `package.json`: `"license": "FSL-1.1-MIT"` for the core app packages; `"license": "MIT"` + their own `LICENSE` in `packages/sdk`, `packages/protocol`, `packages/remote-client`.
- `NOTICE` — not required by FSL; include only if you later carry Apache-2.0 code that has a NOTICE. Instead ship `THIRD_PARTY_NOTICES.md` generated at release (e.g. from the CycloneDX SBOM with `--gather-license-texts`).
- `TRADEMARK.md` — adapt the Linux Foundation trademark usage guidelines (CC BY 4.0) + Rust policy structure: name/logo are trademarks; nominative use OK; "ByteBureau-compatible", plugin names like `bytebureau-plugin-foo` OK; forks must be renamed and not imply endorsement; no merch/events/domains with the mark without permission.
- `CONTRIBUTING.md` — DCO (`git commit -s`), inbound = outbound ("contributions are licensed under the project's FSL-1.1-MIT / MIT per package"), conventional PR titles, dev setup, review SLA.
- `.github/workflows/dco` — not a workflow: install the **DCO GitHub App** (apps/dco) and set `web_commit_signoff_required: true`.
- README "License" section wording: "ByteBureau is Fair Source under the Functional Source License (FSL-1.1-MIT): free to use, read, modify and contribute; the only restriction is offering it as a competing commercial product. Each release becomes MIT two years after publication. SDK packages are MIT."
- Trademark filing: Czech national mark first (5 000 CZK, classes 9 + 42) or EUTM (EUR 900 for two classes) — **after** a TMview/BOIP clearance search because of the Belgian "ByteBureau".

### 3.3 Repository checklist (settings, files, actions)

**A. Ownership & plan**
1. Create an organization (free): `getbytebureau` / `bytebureauhq` / `bytebureau-dev` (all free as of 2026-10-02); transfer `misaon/byte-bureau` into it. Reasons: merge queue ("public repository owned by an organization"), org-level 2FA requirement, org-wide `.github` defaults, teams in CODEOWNERS/bypass lists, safe-settings later, bus-factor.
2. Turn on 2FA (mandatory anyway for release creators); SSH commit signing + vigilant mode on the owner's account.
3. Reserve the npm org/scope `@bytebureau` and Docker Hub `bytebureau` now; register `bytebureau.dev` (+ `.app`, `.cz`); watch `bytebureau.com` (expires 2026-12-05) for a drop.

**B. Repo features (CLI)**
```bash
R=getbytebureau/byte-bureau   # or misaon/byte-bureau until transferred
gh repo edit $R \
  --description "The AI office: orchestrate coding agents in a pixel-art bureau" \
  --homepage https://bytebureau.dev \
  --enable-wiki=false --enable-projects=false --enable-discussions \
  --enable-merge-commit=false --enable-rebase-merge=false --enable-squash-merge \
  --delete-branch-on-merge --allow-update-branch --enable-auto-merge \
  --enable-secret-scanning --enable-secret-scanning-push-protection \
  --add-topic ai-agents --add-topic coding-agents --add-topic multi-agent \
  --add-topic developer-tools --add-topic typescript --add-topic docker \
  --add-topic pixel-art --add-topic fair-source --add-topic fsl --add-topic bun
gh api -X PATCH repos/$R -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY -F web_commit_signoff_required=true
gh api -X PUT repos/$R/vulnerability-alerts            # Dependabot alerts + dependency graph
gh api -X PUT repos/$R/automated-security-fixes        # Dependabot security updates
gh api -X PUT repos/$R/private-vulnerability-reporting # PVR
```
UI-only (no verified CLI): CodeQL default setup (JavaScript/TypeScript + GitHub Actions; "extended" query suite), immutable releases toggle (Settings → General → Releases / org policy; how-to page `prevent-release-changes`), social preview upload, Discussions category cleanup (keep Announcements, Q&A, Ideas, Show and tell; drop Polls/General), Actions settings: "Allow OWNER, and select non-OWNER actions and reusable workflows" + "Allow actions created by GitHub" + "Allow Marketplace actions by verified creators" + explicit allowlist; "Require approval for all external contributors" (relax to "first-time contributors" once the community is healthy); workflow permissions "Read repository contents and packages permissions"; enable "Allow GitHub Actions to create and approve pull requests" only if release PRs are bot-created; artifact retention 30 days.

**C. Rulesets (replace legacy branch protection)** — `gh api -X POST repos/$R/rulesets --input main-ruleset.json`
```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          { "context": "ci / check" }, { "context": "ci / test" },
          { "context": "semantic-pr" }, { "context": "zizmor" } ] } },
    { "type": "code_scanning", "parameters": { "code_scanning_tools": [
          { "tool": "CodeQL", "security_alerts_threshold": "high_or_higher",
            "alerts_threshold": "errors" } ] } }
  ]
}
```
(`actor_id` 5 = repository "Admin" role is the commonly used id — **unverified**; check with `gh api repos/$R/rulesets` after creating one in the UI. Once in an org, add `{ "type": "merge_queue" }` and a Team bypass. Do **not** add `required_signatures`.)

Tag ruleset (`target: "tag"`, include `refs/tags/v*`): rules `creation`, `update`, `deletion`, `non_fast_forward`; bypass: repository admin + the GitHub Actions app if the release workflow creates tags (Integration actor; the Actions app id must be looked up — **unverified**). Combine with immutable releases.

**D. Files (tree)**
```
LICENSE.md  TRADEMARK.md  README.md  README.cs.md  CHANGELOG.md
CONTRIBUTING.md  CODE_OF_CONDUCT.md (Contributor Covenant 3.0, CC BY-SA 4.0)
SECURITY.md (PVR link, supported versions, 90-day disclosure, E2EE/telemetry scope)
SUPPORT.md (Discussions Q&A, Discord if any, no email support)
GOVERNANCE.md (BDFL now; maintainer ladder; decision = ADR)
.github/CODEOWNERS            (* @owner ; /.github/ @owner ; /packages/sdk/ @owner)
.github/FUNDING.yml           (github: [misaon])
.github/ISSUE_TEMPLATE/bug.yml, feature.yml, plugin.yml, config.yml (blank_issues_enabled: false; contact_links → Discussions Q&A, Security advisory form)
.github/PULL_REQUEST_TEMPLATE.md  (checklist: conventional title, tests, docs, ADR?, DCO sign-off, screenshots for UI)
.github/DISCUSSION_TEMPLATE/ideas.yml (optional)
.github/labeler.yml            (area:* by path, kind:* by branch)
.github/release-drafter.yml    (only if you choose label-driven notes)
.github/dependabot.yml  OR  renovate.json  (pick one for version updates; keep Dependabot alerts/security updates on)
.github/copilot-instructions.md, CLAUDE.md (review guidance for bots)
.github/workflows/ci.yml, release.yml, scorecard.yml, zizmor.yml, labeler.yml, stale.yml, semantic-pr.yml, claude.yml
.all-contributorsrc
docs/decisions/0001-record-architecture-decisions.md … (MADR 4.0)
```

**E. Workflows (versions observed; pin to SHAs via Renovate `helpers:pinGitHubActionDigests` once added)**
- `ci.yml`: top-level `permissions: contents: read`; `step-security/harden-runner@v2.21.1` (`egress-policy: audit` → `block` later); `actions/checkout@v7.0.1` with `persist-credentials: false`; Bun/Node setup; `bun run check` (Biome/tsc), `bun test`; `merge_group:` trigger ready for the org move.
- `semantic-pr.yml`: `amannn/action-semantic-pull-request@v6.1.1` on `pull_request_target` `[opened, edited, synchronize, reopened]`, `permissions: pull-requests: read`; `types: feat fix perf refactor docs test build ci chore revert`, `requireScope: false`, `subjectPattern: ^(?![A-Z]).+$`.
- `labeler.yml`: `actions/labeler@v7.0.0` on `pull_request_target`, `permissions: contents: read, pull-requests: write`, no checkout.
- `stale.yml`: `actions/stale@v11.0.0`, cron weekly, `days-before-stale: 90`, `days-before-close: 14`, `exempt-labels: pinned,security,roadmap,good first issue,help wanted`, `exempt-all-assignees: true`, friendly `stale-issue-message` ("still relevant? comment to keep it open"), never auto-close PRs with `exempt-pr-labels: wip`.
- `scorecard.yml`: `ossf/scorecard-action@v2.4.4` on push to main + weekly; `permissions: security-events: write, id-token: write, contents: read, actions: read`; `publish_results: true`; upload SARIF via `github/codeql-action/upload-sarif`.
- `zizmor.yml`: `zizmorcore/zizmor-action` (or `uvx zizmor --persona pedantic --format sarif .github/workflows`) → code scanning; also run in `lefthook` pre-commit.
- `claude.yml`: `anthropics/claude-code-action@v1` on `issue_comment`/`pull_request_review_comment` containing `@claude` (write-access users only) and an automatic review job on `pull_request` with a scoped `prompt`; secret `ANTHROPIC_API_KEY`; `permissions: contents: read, pull-requests: write, issues: write`; skip for forks until approved.
- `release.yml` (on `push: tags: v*`): build binaries (matrix) → `@cyclonedx/cyclonedx-npm --output-file sbom.cdx.json` (npm lock) or `syft` (bun lock) → `actions/attest-build-provenance@v4.2.2` (`subject-path: dist/*`) + `actions/attest-sbom` → `sigstore/cosign-installer@v4.1.2` + `cosign sign-blob --yes --bundle $f.sigstore.json $f` for each asset (so Scorecard's Signed-Releases scores) → `changelogen gh release` or `changelogithub` to write emoji release notes → create **draft** release, upload assets + `.sigstore.json` + `sbom.cdx.json`, then publish (immutable). npm packages: trusted publishing (`permissions: id-token: write`, `npm publish --provenance --access public`, npm ≥ 11.5.1 / Node ≥ 22.14; first publish of each package manually).
- Version bump + CHANGELOG: `npx changelogen --release --push` locally (emoji sections, tags, GitHub release) or a `release-please-action@v4` Release PR (`changelog-sections` with emoji titles, `simple`/`node` type). Pick changelogen for a solo maintainer (zero extra bots), release-please once multiple maintainers merge daily.
- Dependencies: install the Mend Renovate app with `renovate.json`:
  `{"$schema":"https://docs.renovatebot.com/renovate-schema.json","extends":["config:best-practices",":semanticCommits","group:allNonMajor","schedule:weekly"],"minimumReleaseAge":"7 days","dependencyDashboard":true,"labels":["dependencies"]}` — or `dependabot.yml` with `cooldown`, `groups`, `commit-message.prefix: "chore(deps)"`, ecosystems `npm`/`bun` + `github-actions` + `docker`.
- Bots: DCO app, all-contributors bot (`.all-contributorsrc` + `<!-- ALL-CONTRIBUTORS-LIST:START -->` markers), optional Settings app (`.github/settings.yml` for labels, guarded by CODEOWNERS).

**F. Labels taxonomy** (create via `gh label create`): `kind: bug|feature|docs|chore|security`, `area: orchestrator|office-ui|plugins|remote|telemetry|docs|ci`, `priority: p0..p3`, `status: needs-triage|needs-repro|blocked|ready`, `good first issue`, `help wanted`, `pinned`, `wip`, `breaking`, `dependencies`, `release`. Labeler maps `area:*` from paths; release notes group by `kind:*`/conventional type.

**G. Security posture summary**: PVR on + SECURITY.md; Dependabot alerts + security updates; secret scanning + push protection; CodeQL default setup (JS/TS + Actions); Scorecard badge; zizmor + harden-runner; read-only tokens; SHA-pinned actions (Renovate); CODEOWNERS on `.github/`; fork-PR approval gate; no `pull_request_target` with checkout; immutable releases + attestations + cosign bundles + SBOM; npm provenance; interaction limits ready for spam waves; 2FA.

### 3.4 README outline (section-by-section) and asset plan

1. **Header block** (centered): `<picture>` dark/light animated pixel-art office banner (GIF ≤ 2–3 MB, 1200×400; export from Aseprite, optimise with gifski; static SVG/PNG fallback), `<h1>ByteBureau</h1>`, one-liner ("Your AI office: a bureau of coding agents in Docker, orchestrated from one pixel-art floor — and from your phone."), 5–7 badges (release, CI, Scorecard, license `FSL-1.1-MIT`, npm, Discord/Discussions, sponsors), link bar (Docs · Install · Plugins · Roadmap · Contributing), language links `English | Čeština`.
2. **Hero demo**: uploaded `.mp4` (≤ 10 MB on the free plan, H.264) of the office with agents working + the phone remote, or a VHS-made GIF for the CLI; alt-text caption.
3. **What is ByteBureau?** — 3 short paragraphs with bold leads (Biome style): the problem (juggling agents/terminals), the metaphor (office = runtime, desks = containers, phone = E2EE remote), the promise (observable, auditable, extensible).
4. **Quick start** — copy-paste blocks grouped by package manager (`bunx bytebureau`, `npm i -g`, Homebrew tap, Docker, install script) in a `<details>` for the long tail; "60-second tour" numbered steps.
5. **Features grid** — 2-column table (OpenHands style) or emoji bullets: 🏢 office simulation, 🐳 sandboxed agents, 🔌 plugins, 📱 E2EE phone remote, 📊 telemetry, 🤖 works with Claude Code / Codex / OpenCode… (each with a tiny GIF or screenshot).
6. **Screenshots gallery** — 3–6 images in a table, dark/light variants.
7. **Why ByteBureau?** — honest comparison table vs. plain terminals, OpenHands Agent Canvas, Paseo-style dashboards (feature rows: sandboxing, visual sim, remote, plugins, license, offline).
8. **How it works** — one Mermaid diagram (orchestrator ↔ agent containers ↔ plugins ↔ remote), theme-neutral colours; link to ADRs.
9. **Roadmap** — checklist `- [x]/- [ ]` with links to tracking issues/Discussions.
10. **Plugins** — how to write one (MIT SDK), link to registry/docs.
11. **Security & privacy** — sandbox model, E2EE, telemetry opt-in, `SECURITY.md`, PVR, attestations (`gh attestation verify`).
12. **Contributing** — DCO, good-first-issue link, `contrib.rocks` image, all-contributors table.
13. **Community & sponsors** — Discussions/Discord, GitHub Sponsors button, sponsor tiers (Biome pattern).
14. **Star history** — `api.star-history.com/svg?repos=ORG/REPO&type=Date` behind a `<picture>` (it supports `&theme=dark`).
15. **License** — Fair Source paragraph (§3.2), trademark note, "Made with ❤️ in Czechia".
Asset plan: `assets/readme/{banner-dark,banner-light}.gif|svg`, `assets/readme/demo.mp4` (uploaded via issue drag-drop to get a `user-attachments` URL), `assets/readme/*.gif` from VHS tapes checked in under `tapes/` (reproducible), social preview `assets/social-preview.png` (1280×640, solid bg), `README.cs.md` mirrored sections. Lint with markdownlint; keep ≤ 300 lines.

### 3.5 Docs site recommendation

**Astro Starlight** (0.42.5) in `apps/docs`, deployed to **Cloudflare Pages** (500 builds/month, free; or GitHub Pages via Actions), Pagefind search, English content with `locales: { root: { label: 'English', lang: 'en' }, cs: { label: 'Čeština', lang: 'cs' } }` ready (fallback notice keeps partial Czech acceptable), `starlight-docsearch` once DocSearch approves. Why over VitePress: VitePress 2 is still alpha; Starlight has built-in Czech UI, Pagefind, MDX/Markdoc, and a long list of serious adopters. Rspress 2 is the runner-up if the owner wants a React/MDX + multi-version docs + llms.txt pipeline; Fumadocs if the docs must live inside a Next.js/React Router app. Keep `CHANGELOG.md` (changelogen) as the source of truth, mirror into GitHub Releases (immutable), and render "What's new" in-app by fetching the Releases API (`GET /repos/{o}/{r}/releases`) at startup (design note, not researched). ADRs as MADR 4.0 in `docs/decisions/` surfaced in the docs site via a sidebar autogenerate.

---

## 4. Rejected options (and why)

| Option | Why rejected |
|---|---|
| SSPL | OSI: not open source, "deception" if marketed as such; Section 13 overreach; Redis abandoned it after community damage. |
| Commons Clause | Add-on that mutates an OSI license; its own FAQ admits community rejection; negligible 2025–26 adoption; legally muddy. |
| BUSL 1.1 | Needs a bespoke Additional Use Grant (the ambiguity that triggered OpenTofu); 4-year default; "complex" per fair.io; FSL is the cleaned-up successor. |
| Elastic License 2.0 | Only blocks managed services and license-key circumvention — a commercial desktop clone remains legal; no conversion. |
| n8n Sustainable Use License / other bespoke texts | Forbids commercial redistribution entirely (hurts adoption), bespoke → compliance friction; works for a funded company, not for a new indie project. |
| PolyForm Noncommercial / Internal Use / Small Business | Prevents ordinary developers from using it at work → kills adoption; no conversion. |
| PolyForm Shield/Perimeter | Same intent as FSL but no conversion date, far less adoption and no ecosystem (Fair Source) around it. |
| EUPL 1.2 | Attractive on paper (Czech text, Czech law, SaaS clause, OSI) but ~100 starred repos on GitHub, unknown to the global TS community, compatibility clause lets downstream relicense to GPL/MPL; keep as a fallback only if an EU-public-sector angle appears. |
| CLA by default | Archived tooling (contributor-assistant action, 2026-03-23), friction; DCO suffices unless dual-licensing revenue is planned. |
| Requiring signed commits in rulesets | Blocks squash merges of any PR with an unsigned commit; contributor friction; provenance attestations give stronger supply-chain guarantees. |
| GitHub Wiki / Projects | Wiki is unversioned and unlinted (use the docs site); Projects only if the owner will actually groom them — disable now, enable later. |
| safe-settings for one repo | Org-only architecture; overkill. |
| Vercel Hobby for docs | "non-commercial, personal use only"; risk once ByteBureau has paid offerings. |
| VitePress 2 today | Alpha (2.0.0-alpha.20); fine for experiments, not for a public docs site launch. |
| Copilot code review as the only bot reviewer | Requires a paid Copilot plan and credits; Claude Code Action covers the same with the owner's existing API access; combine if budget allows. |

---

## 5. Open questions for the owner

1. **Commercial intent?** Will ByteBureau ever have a paid cloud/pro tier or a company behind it? Yes/maybe → FSL-1.1-MIT (#1). No, and community size is the goal → AGPL-3.0 (#2) or Apache-2.0 (#3).
2. **Are you comfortable never calling it "open source"** and forgoing the OpenSSF Best Practices badge, GitHub Accelerator eligibility and some distro packaging?
3. **Licensor identity**: personal name now vs. founding an s.r.o. first (affects the FSL "we", trademark owner, GitHub Sponsors/Stripe, taxes). Re-licensing from person → company later is simple for your own code but awkward for contributions.
4. **Name clearance**: a Belgian GitHub org "ByteBureau" (2023), a parked `bytebureau.com` (2017, expires 2026-12-05) and a 2020 Brazilian "ByteBureau" company deck exist. Run TMview/BOIP/ÚPV/USPTO searches (manual) — keep "ByteBureau", or pick an alternative before the launch banner is drawn?
5. **Org vs personal repo**: OK to create `getbytebureau`/`bytebureauhq`/`bytebureau-dev` and transfer the repo now (merge queue, 2FA policy, teams)?
6. **DCO vs CLA**: do you want to keep the option of selling commercial exceptions (needs a CLA; hosted cla-assistant.io or a self-maintained fork of the archived action)?
7. **Plugin SDK license** MIT (recommended) vs Apache-2.0 (patent grant) — any patent concerns?
8. **Package manager/lockfile** (bun.lock vs package-lock.json) decides the SBOM tool (`cyclonedx-npm` vs `syft`/`cyclonedx-node-pnpm`) and the Dependabot `bun` ecosystem.
9. **Bots budget**: Claude Code Action (API key spend per PR) and/or Copilot code review (Pro+/Business)?
10. **Community venue**: GitHub Discussions only, or Discord too (badge + moderation load)?
11. **Docs languages**: English-only docs at launch with a Czech locale skeleton, or full cs parity (translation workload)? Czech UI strings for the app are out of this cluster.
12. **Telemetry + E2EE remote**: SECURITY.md needs a threat model and disclosure window; who is the second security contact?
13. **Competitive note** (observed, not researched): All-Hands-AI/OpenHands' README now markets "Agent Canvas — the self-hosted developer control center for coding agents … Run OpenHands, Claude Code, Codex, Gemini, or any ACP-compatible agent across local, remote, and cloud backends" (MIT, 89.7k stars). Worth a line in the "Why ByteBureau" table and in positioning.

---

## 6. Sources (fetched 2026-10-02 unless noted)

Licenses and legal
- https://fsl.software/ ; https://raw.githubusercontent.com/getsentry/fsl.software/main/FSL-1.1-MIT.template.md ; https://github.com/getsentry/sentry/blob/master/LICENSE.md ; https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/ ; https://spdx.org/licenses/FSL-1.1-MIT.html
- https://fair.io/ ; https://fair.io/companies/ ; https://fair.io/faq/ ; https://fair.io/licenses/ ; https://fcl.dev/ ; https://github.com/keygen-sh/keygen-api/blob/master/LICENSE.md
- https://mariadb.com/bsl11/ ; https://github.com/hashicorp/terraform/blob/main/LICENSE ; https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license ; https://opentofu.org/
- https://www.elastic.co/licensing/elastic-license ; https://github.com/elastic/elasticsearch/blob/main/licenses/ELASTIC-LICENSE-2.0.txt ; https://www.elastic.co/blog/elasticsearch-is-open-source-again ; https://github.com/airbytehq/airbyte/blob/master/LICENSE
- https://www.mongodb.com/legal/licensing/server-side-public-license ; https://opensource.org/blog/the-sspl-is-not-an-open-source-license ; https://opensource.org/osd
- https://redis.io/blog/agplv3/ ; https://www.gnu.org/licenses/agpl-3.0.html
- https://polyformproject.org/ ; https://polyformproject.org/licenses ; https://polyformproject.org/licenses/shield/1.0.0 ; https://polyformproject.org/licenses/perimeter/1.0.1 ; https://polyformproject.org/licenses/noncommercial/1.0.0
- https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12 ; https://interoperable-europe.ec.europa.eu/sites/default/files/custom-page/attachment/2020-03/EUPL-1.2%20EN.txt ; https://interoperable-europe.ec.europa.eu/collection/eupl/matrix-eupl-compatible-open-source-licences
- https://commonsclause.com/ ; https://github.com/n8n-io/n8n/blob/master/LICENSE.md ; https://faircode.io/
- https://github.com/PostHog/posthog/blob/master/LICENSE ; https://github.com/dubinc/dub/blob/main/LICENSE.md ; https://github.com/twentyhq/twenty/blob/main/LICENSE ; https://github.com/formbricks/formbricks/blob/main/LICENSE ; https://github.com/calcom/cal.com (LICENSE + README) ; GitHub REST `GET /repos/{owner}/{repo}` license fields for 35 repos; GitHub code/repo search counts via `gh api search/code` and `search/repositories`
- https://www.copyright.gov/help/faq/faq-protect.html ; https://www.wto.org/english/docs_e/legal_e/27-trips_04_e.htm ; https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32009L0024 ; https://www.zakonyprolidi.cz/cs/2000-121 ; https://opensource.guide/legal/
- https://developercertificate.org/ ; https://github.com/apps/dco ; https://github.com/contributor-assistant/github-action (archived 2026-03-23) ; https://cla-assistant.io/
- https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors ; https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/setting-up-github-sponsors-for-your-personal-account ; https://accelerator.github.com/ ; https://www.bestpractices.dev/en/criteria/0 ; https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository ; https://docs.npmjs.com/cli/v11/configuring-npm/package-json

Trademark / name
- https://rustfoundation.org/policy/rust-trademark-policy/ ; https://www.linuxfoundation.org/legal/trademark-usage ; https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32017R1001 (Annex I fees, Art. 46, 52) ; https://www.zakonyprolidi.cz/cs/2004-634 (položka 138) ; https://europa.eu/youreurope/business/running-business/intellectual-property/trade-marks/index_en.htm
- Registry/API probes: registry.npmjs.org (packages, users, scope search), api.github.com (users/orgs/search), crates.io API, pypi.org JSON, hub.docker.com v2, formulae.brew.sh, rdap.org + rdap.nic.cz, itunes.apple.com/search, bytebureau.com

GitHub repo setup
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets ; …/available-rules-for-rulesets ; …/creating-rulesets-for-a-repository ; https://docs.github.com/en/rest/repos/rules ; https://docs.github.com/en/rest/repos/repos ; https://cli.github.com/manual/gh_repo_edit ; https://cli.github.com/manual/gh_ruleset
- `github/docs` source: data/reusables/gated-features/{merge-queue,repo-rules,protected-branches,private-vulnerability-reporting}.md ; content/code-security/concepts/supply-chain-security/immutable-releases.md ; content/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.md
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches ; https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue ; https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges ; https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification ; https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication
- https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms ; …/configuring-issue-templates-for-your-repository ; https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file ; https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository ; …/about-code-owners ; …/classifying-your-repository-with-topics ; …/customizing-your-repositorys-social-media-preview ; https://docs.github.com/en/communities/moderating-comments-and-conversations/limiting-interactions-in-your-repository ; https://docs.github.com/en/discussions/quickstart ; https://docs.github.com/en/discussions/managing-discussions-for-your-community/managing-categories-for-discussions ; https://www.contributor-covenant.org/version/3/0/code_of_conduct/ ; https://www.contributor-covenant.org/translations/ ; EthicalSource/contributor_covenant git history
- https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository ; https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning ; https://docs.github.com/en/code-security/secret-scanning/enabling-secret-scanning-features/enabling-push-protection-for-your-repository ; https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file ; https://docs.renovatebot.com/upgrade-best-practices/ ; https://github.com/apps/renovate
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions ; https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository ; https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/ ; https://docs.zizmor.sh/ ; https://github.com/step-security/harden-runner ; https://github.com/ossf/scorecard-action ; https://github.com/ossf/scorecard/blob/main/docs/checks.md
- https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds ; https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases ; https://docs.sigstore.dev/cosign/signing/signing_with_blobs/ ; https://github.com/CycloneDX/cyclonedx-node-npm ; https://docs.npmjs.com/trusted-publishers
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review ; https://docs.github.com/en/copilot/concepts/agents/code-review ; https://github.com/anthropics/claude-code-action
- https://github.com/github/safe-settings ; https://github.com/repository-settings/app ; https://github.com/actions/stale ; https://github.com/actions/labeler ; https://allcontributors.org/docs/en/bot/installation ; https://github.com/unjs/changelogen ; https://github.com/antfu/changelogithub ; https://github.com/release-drafter/release-drafter ; https://github.com/googleapis/release-please ; https://github.com/googleapis/release-please-action ; https://github.com/googleapis/release-please/blob/main/docs/customizing.md ; https://github.com/amannn/action-semantic-pull-request ; GitHub REST `releases/latest` for 40 tools (versions table in §2.3)

README
- READMEs via `GET /repos/{owner}/{repo}/readme` for oven-sh/bun, zed-industries/zed, anomalyco/opencode, biomejs/biome, withastro/astro, drizzle-team/drizzle-orm, tauri-apps/tauri, honojs/hono, sharkdp/hyperfine, charmbracelet/gum, darrenburns/posting, jesseduffield/lazygit, ghostty-org/ghostty, yorukot/superfile, vitejs/vite, shadcn-ui/ui, charmbracelet/vhs, unjs/nitro, All-Hands-AI/OpenHands
- https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files ; …/creating-diagrams ; https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax ; https://github.blog/news-insights/product-news/video-uploads-available-github/ (2021-05-13) ; GitHub code search `"github.com/user-attachments/assets" ".mp4" filename:README.md` (9 824 hits)
- https://github.com/charmbracelet/vhs ; https://github.com/asciinema/agg ; https://github.com/sindresorhus/gifski (release tag) ; https://www.aseprite.org/docs/cli/ ; badge endpoints probed with curl (shields.io, api.scorecard.dev, api.star-history.com, contrib.rocks, socket.dev)

Docs site
- https://starlight.astro.build/ ; https://starlight.astro.build/guides/i18n/ ; https://starlight.astro.build/guides/site-search/ ; https://vitepress.dev/ ; https://vitepress.dev/guide/i18n ; https://rspress.rs/ ; https://rspress.rs/guide/start/introduction ; https://rspress.rs/llms.txt ; https://fumadocs.dev/docs ; https://fumadocs.dev/docs/internationalization ; https://docusaurus.io/docs/i18n/introduction ; https://nextra.site/docs/guide/i18n ; https://mintlify.com/pricing ; https://docsearch.algolia.com/docs/who-can-apply/ ; https://pagefind.app/ ; https://adr.github.io/madr/ ; https://developers.cloudflare.com/pages/platform/limits/ ; https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; https://vercel.com/docs/plans/hobby ; GitHub `releases/latest` for vuejs/vitepress, withastro/starlight, fuma-nama/fumadocs, facebook/docusaurus, shuding/nextra, web-infra-dev/rspress, Pagefind/pagefind, adr/madr, npryce/adr-tools

Not reachable / unverified: EUIPO fee pages (403; replaced by the EU Regulation text), modeltrademarkguidelines.org (TLS error), TMview/USPTO (no automated search), Kyle Mitchell FSL commentary (404), Mintlify OSS programme details, Mermaid theming on GitHub, Socket badge, Google Play, `.io` RDAP, Actions-app/RepositoryRole numeric ids in ruleset bypass lists.
