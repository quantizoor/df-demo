export interface BetaPosterior {
  readonly alpha: number;
  readonly beta: number;
}

export interface CredibleInterval {
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
}

export interface WeightedBetaDifference {
  readonly candidate: BetaPosterior;
  readonly champion: BetaPosterior;
  readonly weight: number;
}

export interface DifferencePosteriorSummary {
  readonly probabilityGreaterThanThreshold: number;
  readonly threshold: number;
  readonly median: number;
  readonly interval95: CredibleInterval;
  readonly integrationPoints: number;
}

export interface PairedCategoryCounts {
  readonly bothPass: number;
  readonly challengerOnlyPass: number;
  readonly championOnlyPass: number;
  readonly bothFail: number;
}

export interface WeightedPairedStratum {
  readonly counts: PairedCategoryCounts;
  readonly weight: number;
}

export interface PairedPosteriorSummary extends DifferencePosteriorSummary {
  readonly stratumProbabilityBelowMinusPointOne: readonly number[];
}

export interface OnlineErrorBudgetState {
  readonly policyVersion: "online-alpha-spending-v1";
  readonly nullCalibrationId: string;
  readonly initialAlpha: number;
  readonly remainingAlpha: number;
  readonly spentAlpha: number;
  readonly gatesSpent: number;
}

export interface OnlineGateAllocation {
  readonly authorized: boolean;
  readonly alphaSpent: number;
  readonly requiredPosteriorProbability: number;
  readonly nextState: OnlineErrorBudgetState;
}

/**
 * Task-identity-free accounting suitable for signed evaluator releases and
 * campaign-budget reconciliation.
 */
export interface ReleaseSafeOnlineErrorBudgetAccounting {
  readonly policyVersion: "online-alpha-spending-v1";
  readonly maximumOnlineError: number;
  readonly gateOrdinal: number;
  readonly alphaSpent: number;
  readonly cumulativeSpentBefore: number;
  readonly cumulativeSpentAfter: number;
  readonly remainingAfter: number;
  readonly reservationHash: string;
  readonly priorStateHash: string;
  readonly resultingStateHash: string;
}

const DEFAULT_INTEGRATION_POINTS = 4096;
export const MINIMUM_ONLINE_GATE_ALPHA = 1e-6;

export function jeffreysPosterior(passes: number, failures: number): BetaPosterior {
  assertCount(passes, "passes");
  assertCount(failures, "failures");
  return { alpha: passes + 0.5, beta: failures + 0.5 };
}

export function betaCredibleInterval(
  posterior: BetaPosterior,
  mass = 0.95,
): CredibleInterval {
  validatePosterior(posterior);
  if (!(mass > 0 && mass < 1)) {
    throw new Error("Credible interval mass must be in (0, 1)");
  }
  const tail = (1 - mass) / 2;
  const lower = inverseRegularizedBeta(tail, posterior.alpha, posterior.beta);
  const upper = inverseRegularizedBeta(1 - tail, posterior.alpha, posterior.beta);
  return { lower, upper, width: upper - lower };
}

/**
 * Deterministic low-discrepancy quadrature over independent beta posteriors.
 * It is deliberately seedless: the same validated evidence always yields the
 * same decision on every platform.
 */
export function summarizeWeightedBetaDifference(
  terms: readonly WeightedBetaDifference[],
  threshold: number,
  integrationPoints = DEFAULT_INTEGRATION_POINTS,
): DifferencePosteriorSummary {
  validateIntegrationPoints(integrationPoints);
  validateWeights(terms.map((term) => term.weight));
  terms.forEach((term) => {
    validatePosterior(term.candidate);
    validatePosterior(term.champion);
  });

  const samples: number[] = [];
  const bases = Array.from({ length: terms.length * 2 }, (_, index) => primeAt(index));
  for (let sampleIndex = 1; sampleIndex <= integrationPoints; sampleIndex += 1) {
    let delta = 0;
    terms.forEach((term, termIndex) => {
      const candidateBase = bases[termIndex * 2];
      const championBase = bases[termIndex * 2 + 1];
      if (candidateBase === undefined || championBase === undefined) {
        throw new Error("Internal quadrature dimension error");
      }
      const candidateQuantile = radicalInverse(sampleIndex, candidateBase);
      const championQuantile = radicalInverse(sampleIndex, championBase);
      const candidate = inverseRegularizedBeta(
        candidateQuantile,
        term.candidate.alpha,
        term.candidate.beta,
      );
      const champion = inverseRegularizedBeta(
        championQuantile,
        term.champion.alpha,
        term.champion.beta,
      );
      delta += term.weight * (candidate - champion);
    });
    samples.push(delta);
  }
  return summarizeSamples(samples, threshold);
}

/**
 * A four-cell Dirichlet-Jeffreys posterior can be reduced for accuracy delta:
 * discordant mass s is beta-distributed and the challenger share r within
 * discordant mass is independently beta-distributed; delta = s * (2r - 1).
 */
export function summarizePairedDirichletJeffreys(
  strata: readonly WeightedPairedStratum[],
  threshold = 0,
  integrationPoints = DEFAULT_INTEGRATION_POINTS,
): PairedPosteriorSummary {
  validateIntegrationPoints(integrationPoints);
  validateWeights(strata.map((stratum) => stratum.weight));
  strata.forEach((stratum) => validateCategoryCounts(stratum.counts));

  const combinedSamples: number[] = [];
  const belowByStratum = new Array<number>(strata.length).fill(0);
  const bases = Array.from({ length: strata.length * 2 }, (_, index) => primeAt(index));
  for (let sampleIndex = 1; sampleIndex <= integrationPoints; sampleIndex += 1) {
    let combined = 0;
    strata.forEach((stratum, stratumIndex) => {
      const counts = stratum.counts;
      const discordantAlpha =
        counts.challengerOnlyPass + counts.championOnlyPass + 1;
      const concordantAlpha = counts.bothPass + counts.bothFail + 1;
      const challengerAlpha = counts.challengerOnlyPass + 0.5;
      const championAlpha = counts.championOnlyPass + 0.5;
      const discordantBase = bases[stratumIndex * 2];
      const shareBase = bases[stratumIndex * 2 + 1];
      if (discordantBase === undefined || shareBase === undefined) {
        throw new Error("Internal quadrature dimension error");
      }
      const discordantMass = inverseRegularizedBeta(
        radicalInverse(sampleIndex, discordantBase),
        discordantAlpha,
        concordantAlpha,
      );
      const challengerShare = inverseRegularizedBeta(
        radicalInverse(sampleIndex, shareBase),
        challengerAlpha,
        championAlpha,
      );
      const delta = discordantMass * (2 * challengerShare - 1);
      if (delta < -0.1) {
        const current = belowByStratum[stratumIndex];
        if (current === undefined) {
          throw new Error("Internal stratum index error");
        }
        belowByStratum[stratumIndex] = current + 1;
      }
      combined += stratum.weight * delta;
    });
    combinedSamples.push(combined);
  }

  return {
    ...summarizeSamples(combinedSamples, threshold),
    stratumProbabilityBelowMinusPointOne: belowByStratum.map(
      (count) => count / integrationPoints,
    ),
  };
}

export function createOnlineErrorBudget(
  initialAlpha: number,
  nullCalibrationId: string,
): OnlineErrorBudgetState {
  if (!(initialAlpha > 0 && initialAlpha <= 0.05)) {
    throw new Error("Initial online alpha must be in (0, 0.05]");
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(nullCalibrationId)) {
    throw new Error("A versioned null calibration ID is required");
  }
  return {
    policyVersion: "online-alpha-spending-v1",
    nullCalibrationId,
    initialAlpha,
    remainingAlpha: initialAlpha,
    spentAlpha: 0,
    gatesSpent: 0,
  };
}

/**
 * Uses the summable 6/(pi^2 n^2) schedule. A gate spends its allocation once
 * opened, regardless of its result, so retries cannot recover error budget.
 */
export function allocateOnlineGate(state: OnlineErrorBudgetState): OnlineGateAllocation {
  assertOnlineErrorBudgetState(state);
  const gateNumber = state.gatesSpent + 1;
  const scheduled = (state.initialAlpha * 6) / (Math.PI ** 2 * gateNumber ** 2);
  const alphaSpent = Math.min(scheduled, state.remainingAlpha);
  const authorized = alphaSpent >= MINIMUM_ONLINE_GATE_ALPHA;
  const spent = authorized ? alphaSpent : 0;
  const nextSpent = state.spentAlpha + spent;
  const nextRemaining = Math.max(0, state.initialAlpha - nextSpent);
  return {
    authorized,
    alphaSpent: spent,
    requiredPosteriorProbability: authorized ? Math.max(0.95, 1 - spent) : 1,
    nextState: {
      ...state,
      remainingAlpha: nextRemaining,
      spentAlpha: nextSpent,
      gatesSpent: authorized ? gateNumber : state.gatesSpent,
    },
  };
}

export function assertOnlineGateAllocation(
  state: OnlineErrorBudgetState,
  allocation: OnlineGateAllocation,
): void {
  const expected = allocateOnlineGate(state);
  if (
    allocation.authorized !== expected.authorized ||
    allocation.alphaSpent !== expected.alphaSpent ||
    allocation.requiredPosteriorProbability !==
      expected.requiredPosteriorProbability ||
    allocation.nextState.policyVersion !== expected.nextState.policyVersion ||
    allocation.nextState.nullCalibrationId !==
      expected.nextState.nullCalibrationId ||
    allocation.nextState.initialAlpha !== expected.nextState.initialAlpha ||
    allocation.nextState.remainingAlpha !==
      expected.nextState.remainingAlpha ||
    allocation.nextState.spentAlpha !== expected.nextState.spentAlpha ||
    allocation.nextState.gatesSpent !== expected.nextState.gatesSpent
  ) {
    throw new Error(
      "Reserved online gate does not match the deterministic spending schedule",
    );
  }
}

export function regularizedIncompleteBeta(x: number, alpha: number, beta: number): number {
  validatePosterior({ alpha, beta });
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const logFactor =
    logGamma(alpha + beta) -
    logGamma(alpha) -
    logGamma(beta) +
    alpha * Math.log(x) +
    beta * Math.log1p(-x);
  const factor = Math.exp(logFactor);
  if (x < (alpha + 1) / (alpha + beta + 2)) {
    return (factor * betaContinuedFraction(x, alpha, beta)) / alpha;
  }
  return 1 - (factor * betaContinuedFraction(1 - x, beta, alpha)) / beta;
}

export function inverseRegularizedBeta(
  probability: number,
  alpha: number,
  beta: number,
): number {
  validatePosterior({ alpha, beta });
  if (probability <= 0) {
    return 0;
  }
  if (probability >= 1) {
    return 1;
  }
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 72; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (regularizedIncompleteBeta(midpoint, alpha, beta) < probability) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }
  return (lower + upper) / 2;
}

function summarizeSamples(
  samples: number[],
  threshold: number,
): DifferencePosteriorSummary {
  samples.sort((left, right) => left - right);
  const greater = samples.filter((sample) => sample > threshold).length;
  return {
    probabilityGreaterThanThreshold: greater / samples.length,
    threshold,
    median: quantileFromSorted(samples, 0.5),
    interval95: {
      lower: quantileFromSorted(samples, 0.025),
      upper: quantileFromSorted(samples, 0.975),
      width: quantileFromSorted(samples, 0.975) - quantileFromSorted(samples, 0.025),
    },
    integrationPoints: samples.length,
  };
}

function quantileFromSorted(values: readonly number[], probability: number): number {
  if (values.length === 0) {
    throw new Error("Cannot compute a quantile of an empty sample");
  }
  const position = probability * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = values[lowerIndex];
  const upper = values[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("Internal quantile index error");
  }
  return lower + (upper - lower) * (position - lowerIndex);
}

function radicalInverse(index: number, base: number): number {
  let value = 0;
  let factor = 1 / base;
  let remainder = index;
  while (remainder > 0) {
    value += factor * (remainder % base);
    remainder = Math.floor(remainder / base);
    factor /= base;
  }
  return Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, value));
}

function primeAt(index: number): number {
  let found = -1;
  let candidate = 1;
  while (found < index) {
    candidate += 1;
    if (isPrime(candidate)) {
      found += 1;
    }
  }
  return candidate;
}

function isPrime(value: number): boolean {
  if (value < 2) {
    return false;
  }
  for (let divisor = 2; divisor * divisor <= value; divisor += 1) {
    if (value % divisor === 0) {
      return false;
    }
  }
  return true;
}

function betaContinuedFraction(x: number, alpha: number, beta: number): number {
  const maximumIterations = 200;
  const epsilon = 3e-14;
  const minimum = 1e-300;
  const qab = alpha + beta;
  const qap = alpha + 1;
  const qam = alpha - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  d = 1 / Math.max(Math.abs(d), minimum) * Math.sign(d || 1);
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    const evenNumerator =
      (iteration * (beta - iteration) * x) /
      ((qam + 2 * iteration) * (alpha + 2 * iteration));
    d = 1 + evenNumerator * d;
    d = Math.abs(d) < minimum ? minimum : d;
    c = 1 + evenNumerator / c;
    c = Math.abs(c) < minimum ? minimum : c;
    d = 1 / d;
    result *= d * c;

    const oddNumerator =
      (-(alpha + iteration) * (qab + iteration) * x) /
      ((alpha + 2 * iteration) * (qap + 2 * iteration));
    d = 1 + oddNumerator * d;
    d = Math.abs(d) < minimum ? minimum : d;
    c = 1 + oddNumerator / c;
    c = Math.abs(c) < minimum ? minimum : c;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) {
      return result;
    }
  }
  throw new Error("Incomplete beta continued fraction did not converge");
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }
  const shifted = value - 1;
  let series = 0.9999999999998099;
  coefficients.forEach((coefficient, index) => {
    series += coefficient / (shifted + index + 1);
  });
  const t = shifted + coefficients.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(series)
  );
}

function validatePosterior(posterior: BetaPosterior): void {
  if (
    !Number.isFinite(posterior.alpha) ||
    !Number.isFinite(posterior.beta) ||
    posterior.alpha <= 0 ||
    posterior.beta <= 0
  ) {
    throw new Error("Beta posterior parameters must be finite and positive");
  }
}

function validateWeights(weights: readonly number[]): void {
  if (
    weights.length === 0 ||
    weights.some((weight) => !Number.isFinite(weight) || weight <= 0) ||
    Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9
  ) {
    throw new Error("Posterior weights must be positive and sum to one");
  }
}

function validateIntegrationPoints(points: number): void {
  if (!Number.isSafeInteger(points) || points < 256 || points > 65_536) {
    throw new Error("Integration points must be an integer in [256, 65536]");
  }
}

function validateCategoryCounts(counts: PairedCategoryCounts): void {
  assertCount(counts.bothPass, "bothPass");
  assertCount(counts.challengerOnlyPass, "challengerOnlyPass");
  assertCount(counts.championOnlyPass, "championOnlyPass");
  assertCount(counts.bothFail, "bothFail");
  const total =
    counts.bothPass +
    counts.challengerOnlyPass +
    counts.championOnlyPass +
    counts.bothFail;
  if (total === 0) {
    throw new Error("A paired stratum must contain at least one task");
  }
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function assertOnlineErrorBudgetState(
  state: OnlineErrorBudgetState,
): void {
  if (
    state.policyVersion !== "online-alpha-spending-v1" ||
    !(state.initialAlpha > 0 && state.initialAlpha <= 0.05) ||
    !Number.isFinite(state.remainingAlpha) ||
    state.remainingAlpha < 0 ||
    state.remainingAlpha > state.initialAlpha ||
    !Number.isFinite(state.spentAlpha) ||
    state.spentAlpha < 0 ||
    state.spentAlpha > state.initialAlpha ||
    Math.abs(
      state.remainingAlpha + state.spentAlpha - state.initialAlpha,
    ) > 1e-12 ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(state.nullCalibrationId) ||
    !Number.isSafeInteger(state.gatesSpent) ||
    state.gatesSpent < 0
  ) {
    throw new Error("Invalid online error-budget state");
  }
}
