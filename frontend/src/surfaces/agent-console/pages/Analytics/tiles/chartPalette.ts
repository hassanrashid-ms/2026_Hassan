// Fixed-order categorical palette, validated for light-mode use via the dataviz
// skill's validate_palette.js (adjacent-pair CVD/normal-vision checks pass; the
// aqua/yellow/magenta slots carry a contrast WARN, which the donut tile's legend
// satisfies with visible text labels — never color-alone identity).
// Never cycle: a chart needing a 9th series should fold into "Other" instead.
export const CHART_PALETTE = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export function paletteColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]!;
}
