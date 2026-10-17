// Pure money logic. No I/O here, so it's exhaustively unit-tested.

export type Rules = {
  thresholdSteps: number;
  penaltyCents: number;
};

export type DayInput = {
  /** Members eligible on this day (joined on/before, not left). */
  memberIds: string[];
  /** Steps per member. Missing member = 0 steps. */
  steps: Record<string, number | undefined>;
  /** Members with a pending skip claim for this day. */
  skipClaims: string[];
};

export type DayResult = {
  minSteps: number | null;
  /** Everyone tied at the minimum, only when that minimum is under the threshold. */
  loserIds: string[];
  /** Who actually pays (losers without a skip claim). Ties: everyone tied pays. */
  penalties: { userId: string; cents: number }[];
  /** Losers whose claim saved them. Their claim becomes 'consumed'. */
  skipsConsumed: string[];
  /** Claims that weren't needed (claimer didn't lose). They're released, not counted. */
  skipsReleased: string[];
  outcome: "no_loser" | "penalty" | "skipped";
};

export function computeDay(input: DayInput, rules: Rules): DayResult {
  const members = [...new Set(input.memberIds)];
  const claims = new Set(input.skipClaims.filter((id) => members.includes(id)));

  if (members.length === 0) {
    return {
      minSteps: null,
      loserIds: [],
      penalties: [],
      skipsConsumed: [],
      skipsReleased: [...claims],
      outcome: "no_loser",
    };
  }

  const stepsOf = (id: string) => Math.max(0, Math.floor(input.steps[id] ?? 0));
  const minSteps = Math.min(...members.map(stepsOf));
  const loserIds = minSteps < rules.thresholdSteps ? members.filter((id) => stepsOf(id) === minSteps) : [];

  const skipsConsumed = loserIds.filter((id) => claims.has(id));
  const payers = loserIds.filter((id) => !claims.has(id));
  const skipsReleased = [...claims].filter((id) => !loserIds.includes(id));

  return {
    minSteps,
    loserIds,
    penalties: payers.map((userId) => ({ userId, cents: rules.penaltyCents })),
    skipsConsumed,
    skipsReleased,
    outcome: loserIds.length === 0 ? "no_loser" : payers.length > 0 ? "penalty" : "skipped",
  };
}

/** Can this member claim another skip in this month? Pending + consumed both count. */
export function canClaimSkip(claimsThisMonth: number, skipsPerMonth: number): boolean {
  return claimsThisMonth < skipsPerMonth;
}
