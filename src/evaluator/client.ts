import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type SignedAggregateEnvelope,
  type TrustedEvaluationRequest,
} from "./contracts.js";
import { assertEnvelopeSafeForLocalPersistence } from "./retention.js";
import { type EnvelopeKeyring, verifySignedAggregateEnvelope } from "./signature.js";

export interface TrustedEvaluatorTransport {
  submit(
    endpoint: string,
    request: TrustedEvaluationRequest,
    credentialEnvironmentName: string,
  ): Promise<unknown>;
}

export interface TrustedEvaluatorClientOptions {
  readonly endpoint: string;
  readonly credentialEnvironmentName: string;
  readonly transport: TrustedEvaluatorTransport;
  readonly keyring: EnvelopeKeyring;
}

export class TrustedEvaluatorClientError extends Error {
  override readonly name = "TrustedEvaluatorClientError";
}

function normalizeTrustedEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new TrustedEvaluatorClientError("Trusted evaluator endpoint must be an absolute URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "::1"
  ) {
    throw new TrustedEvaluatorClientError(
      "Trusted evaluator endpoint must be credential-free remote HTTPS.",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
}

export class TrustedEvaluatorClient {
  readonly #endpoint: string;
  readonly #credentialEnvironmentName: string;
  readonly #transport: TrustedEvaluatorTransport;
  readonly #keyring: EnvelopeKeyring;

  constructor(options: TrustedEvaluatorClientOptions) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(options.credentialEnvironmentName)) {
      throw new TrustedEvaluatorClientError("Evaluator credential reference is malformed.");
    }
    this.#endpoint = normalizeTrustedEndpoint(options.endpoint);
    this.#credentialEnvironmentName = options.credentialEnvironmentName;
    this.#transport = options.transport;
    this.#keyring = options.keyring;
  }

  async evaluate(request: TrustedEvaluationRequest): Promise<SignedAggregateEnvelope> {
    assertEvaluationRequest(request);
    const requestHash = hashEvaluationRequest(request);
    const response = await this.#transport.submit(
      this.#endpoint,
      request,
      this.#credentialEnvironmentName,
    );
    const envelope = await verifySignedAggregateEnvelope(
      response,
      request,
      requestHash,
      this.#keyring,
    );
    assertEnvelopeSafeForLocalPersistence(envelope);
    return envelope;
  }
}
