// ---
// relationships:
//   used_by: .github/fork/test.sh
// ---

const buildTimeRelayUrl = normalizeSecureRelayUrl("https://relay.example.invalid") ?? "";
const buildTimeClerkPublishableKey = readBuildTimeValue("pk_test_fixture");
const buildTimeClerkCliOAuthClientId = readBuildTimeValue("oauth-fixture");
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue("https://traces.example.invalid/v1/traces"),
  tracesDataset: readBuildTimeValue("generic-traces"),
  tracesToken: readBuildTimeValue("token-fixture"),
};
