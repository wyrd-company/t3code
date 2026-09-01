// ---
// relationships:
//   used_by: .github/fork/test.sh
// ---
// Generated from package/dist/bin.mjs in the public t3@0.0.37 npm tarball.

const buildTimeRelayUrl = normalizeSecureRelayUrl("https://relay.t3.codes") ?? "";
const buildTimeClerkPublishableKey = readBuildTimeValue("pk_live_Y2xlcmsudDMuY29kZXMk");
const buildTimeClerkCliOAuthClientId = readBuildTimeValue("hzxSgY2cH10sDU2r");
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue("https://api.axiom.co/v1/traces"),
  tracesDataset: readBuildTimeValue("t3-code-relay-traces-prod"),
  tracesToken: readBuildTimeValue("xaat-8933d243-83eb-4ce0-86ba-8cdd018387c5"),
};
