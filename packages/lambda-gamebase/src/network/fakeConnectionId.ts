/**
 * A sentinel connection id for locally simulated members. Network
 * functions treat it as always reachable and never call the API Gateway
 * management API for it.
 */
export const fakeConnectionId = "__FAKE_CONNECTION_ID__";
