# Liquidation oracle USD compatibility rollout

## Review baseline

- V3 [PR #660](https://github.com/euler-xyz/euler-data-v3/pull/660): `b0460d8fdd4a28fdbae2c3bcc86bd58252989d5f`, merged with the rollout gate disabled by default. Deployment and gate state must be verified separately.
- SDK `main` and published 3.4.0 tag: `ff224741c251cae7673c5f835dcf3bbccd9d6605`.
- Lite `development`: `fffb1cfcb964a236cc4e92e5d037c70ad1fd0207`, pinning SDK 3.3.0.
- SDK 3.3.0 and 3.4.0 reject a liquidation page containing `valuation.source: historical-protocol-oracle`.

## Compatible response handling

The compatible [SDK parser patch](https://github.com/euler-xyz/euler-sdks/pull/109) accepts `historical-price-snapshots` and `historical-protocol-oracle`. `LiquidationValuation.source` is a required union of these values; consumers constructing typed records must include the source. Generic activity valuation types are unchanged.

Status still follows the number of available USD legs: two means `available`, one means `partial`, and none means `unavailable`. Finite nonnegative USD legs/prices, nullable native metadata, raw amount strings, and bonus presence validation remain in force. Signed finite USD bonuses are preserved without recomputing them from rounded USD legs. Raw oracle quotes retain their block, decimal, and exact integer bonus validation.

Oracle provenance identifies at least one filled USD leg; a row can combine a snapshot debt value with oracle-valued collateral. USD collateral does not imply native collateral metadata or conversion is available. Lite prefers dedicated liquidation USD values, retains native/share quantities independently, and uses the oracle-denominated bonus when USD bonus is unavailable.

The committed regression fixtures cover one Monad token-denominated case and one Unichain mixed snapshot/oracle case from the V3 head above. These are deterministic compatibility tests, not live production certification of all eleven V3 fixtures.

## Local compatibility testing

Use a sibling `../euler-sdks` checkout containing the compatibility patch, build it, and link it into Lite using the [local SDK workflow](../README.md#development-with-the-sdk). The draft Lite change retains published 3.3.0 in `package.json` and `package-lock.json` until the compatible release is available; no local dependency path is committed.

```sh
(cd ../euler-sdks && pnpm -C packages/euler-v2-sdk run release:check)
(cd ../euler-sdks && pnpm -C packages/euler-v2-sdk test)
npm run test:run -- tests/components/activityEventRow.test.ts tests/composables/useActivityLiquidationDetails.test.ts tests/utils/activity-display.test.ts
npm run typecheck
```

`npm ci` restores the committed dependency. The oracle-source regression tests intentionally fail with 3.3.0/3.4.0: these tests gate the compatible dependency update.

## Local validation

- SDK focused activity tests: 71 passed. Full SDK suite: 47 files / 684 tests passed. The added public type assertion and existing activity type checks pass (3 checks).
- SDK `release:check` (clean build and typecheck), touched-source Biome checks, and a temporary 3.4.1 package dry-run pass. The package includes the built parser and exported type declarations; no version was written into the source manifest.
- Lite: 45 compatibility/display tests plus 28 adjacent activity/liquidation tests pass against the built local SDK (8 files / 73 tests total). Full lint, typecheck, production build, and the full suite (233 files / 2,307 tests, including the logger-bundle check) pass with that local SDK. Both repositories pass `git diff --check`.
- The same Lite compatibility tests reproduce three failures against installed SDK 3.3.0 before linking the patch. SDK 3.4.0 has the same rejecting parser at the verified release commit.
- Lite's full production build/suite and browser/staging checks are pending against the eventual registry release. No live production behavior is claimed.

## Release sequence — pending authorization

Proposed SDK release: **3.4.1**, subject to a fresh registry and release-head check. Publishing, merging, and deploying remain separate release steps.

1. Review and merge the SDK patch when authorized. Recheck current `main`, the latest published version, and the V3 contract. Run the SDK full tests and `release:check` on the selected release commit. Follow `packages/euler-v2-sdk/RELEASE.md`: the version is set temporarily for packing/publishing, with tag `euler-v2-sdk-v3.4.1` and interactive npm authentication. Verify the package exports the updated parser and `LiquidationValuation` type, then confirm registry version, tarball integrity, and `latest` propagation after publication.
2. In Lite, replace the local link with the published package using `npm install --save-exact @eulerxyz/euler-v2-sdk@3.4.1`. Review both `package.json` and `package-lock.json`; neither may resolve to a local path. Run `npm ci`, lint, typecheck, build, and the full test suite against the registry package. Build before tests so the production logger-bundle test executes. Exercise liquidation enrichment with enabled-style responses in staging and verify the displayed USD values, share/native fallbacks, and oracle bonus fallback.
3. Merge and deploy the Lite dependency update when authorized. Confirm the deployed artifact actually uses the compatible SDK. Audit other supported SDK consumers before enabling oracle USD enrichment.
4. Only after the compatible SDK is published and Lite is upgraded, deployed, and verified, deploy V3 #660. This preserves the requested consumer-first deployment order even though the latest V3 head has a default-off gate. Keep `LIQUIDATION_ORACLE_USD_ENABLED=false` until consumer verification is complete; enabling it is a separate controlled action.
5. After explicit enablement, independently verify all eleven production responses from V3's rollout fixtures, including preserved snapshot legs, USD bonuses, source provenance, and Unichain native nulls. The V3 gate partitions response caches; rollback is `LIQUIDATION_ORACLE_USD_ENABLED=false`.

Release-note draft: Accept historical protocol-oracle liquidation USD valuations alongside price snapshots, preserve mixed-leg values and nullable native collateral fields, and retain strict status/numeric/bonus validation. Add parser and consumer compatibility regressions.

Live browser/production validation and validation of the eventual registry package remain release gates.
