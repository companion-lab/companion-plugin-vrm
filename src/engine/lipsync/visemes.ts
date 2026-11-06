const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
export type Viseme = (typeof VISEMES)[number];

export { VISEMES };
