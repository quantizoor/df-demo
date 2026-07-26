import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateOnlineGate,
  betaCredibleInterval,
  createOnlineErrorBudget,
  inverseRegularizedBeta,
  jeffreysPosterior,
  regularizedIncompleteBeta,
  summarizePairedDirichletJeffreys,
  summarizeWeightedBetaDifference,
} from "../../src/evaluation/index.js";

describe("deterministic statistics", () => {
  it("inverts the uniform beta distribution", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0001, max: 0.9999, noNaN: true }),
        (probability) => {
          expect(inverseRegularizedBeta(probability, 1, 1)).toBeCloseTo(probability, 10);
          expect(regularizedIncompleteBeta(probability, 1, 1)).toBeCloseTo(
            probability,
            10,
          );
        },
      ),
    );
  });

  it("produces bounded Jeffreys intervals", () => {
    const interval = betaCredibleInterval(jeffreysPosterior(8, 2));
    expect(interval.lower).toBeGreaterThan(0);
    expect(interval.upper).toBeLessThan(1);
    expect(interval.lower).toBeLessThan(interval.upper);
    expect(interval.width).toBeCloseTo(interval.upper - interval.lower, 12);
  });

  it("replays weighted posterior integration exactly", () => {
    const terms = [
      {
        candidate: jeffreysPosterior(1, 0),
        champion: jeffreysPosterior(0, 3),
        weight: 0.5,
      },
      {
        candidate: jeffreysPosterior(1, 0),
        champion: jeffreysPosterior(0, 2),
        weight: 0.5,
      },
    ];
    const first = summarizeWeightedBetaDifference(terms, -0.1, 512);
    const second = summarizeWeightedBetaDifference(terms, -0.1, 512);
    expect(first).toEqual(second);
    expect(first.probabilityGreaterThanThreshold).toBeGreaterThan(0.8);
    expect(first.median).toBeGreaterThan(0);
  });

  it("uses task-pair categories rather than treating arms as independent samples", () => {
    const strong = summarizePairedDirichletJeffreys(
      [
        {
          counts: {
            bothPass: 0,
            challengerOnlyPass: 6,
            championOnlyPass: 0,
            bothFail: 0,
          },
          weight: 0.5,
        },
        {
          counts: {
            bothPass: 0,
            challengerOnlyPass: 6,
            championOnlyPass: 0,
            bothFail: 0,
          },
          weight: 0.5,
        },
      ],
      0,
      1024,
    );
    expect(strong.probabilityGreaterThanThreshold).toBeGreaterThan(0.99);
    expect(strong.median).toBeGreaterThan(0.5);
    expect(strong.stratumProbabilityBelowMinusPointOne).toEqual([0, 0]);
  });

  it("spends a summable, deterministic campaign-level error budget", () => {
    let state = createOnlineErrorBudget(0.05, "null-simulation-v1");
    let spent = 0;
    for (let index = 0; index < 100; index += 1) {
      const allocation = allocateOnlineGate(state);
      expect(allocation.requiredPosteriorProbability).toBeGreaterThanOrEqual(0.95);
      if (!allocation.authorized) {
        break;
      }
      spent += allocation.alphaSpent;
      state = allocation.nextState;
    }
    expect(spent).toBeLessThanOrEqual(0.05);
    expect(state.remainingAlpha).toBeCloseTo(0.05 - spent, 12);
    expect(state.spentAlpha).toBe(spent);
  });

  it("rejects weights that could silently reweight a panel", () => {
    expect(() =>
      summarizeWeightedBetaDifference(
        [
          {
            candidate: jeffreysPosterior(1, 0),
            champion: jeffreysPosterior(0, 1),
            weight: 0.9,
          },
        ],
        0,
        256,
      ),
    ).toThrow(/sum to one/u);
  });
});
