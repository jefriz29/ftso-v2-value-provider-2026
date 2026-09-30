import { calculateMedianPrice, encodeFeedId, percentageDeviation } from './flare-median-monitor';

describe('Flare median monitor helpers', () => {
  it('encodes a category 1 feed ID', () => {
    expect(encodeFeedId({ category: 1, name: 'BTC/USD' })).toBe('0x014254432f55534400000000000000000000000000');
  });

  it('calculates the middle of three valid prices', () => {
    expect(calculateMedianPrice([0.99923514175, 1.0002, 1])).toBe(1);
  });

  it('ignores unavailable and invalid prices', () => {
    expect(calculateMedianPrice([undefined, 0, 0.0365])).toBe(0.0365);
  });

  it('averages two valid prices', () => {
    expect(calculateMedianPrice([100, 102, undefined])).toBe(101);
  });

  it('calculates percentage deviation from the finalized Flare median', () => {
    expect(percentageDeviation(0.0365, 0.036525)).toBeCloseTo(0.0684462697, 8);
  });
});
