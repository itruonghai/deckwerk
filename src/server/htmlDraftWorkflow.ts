import type { TextOverflow } from '../shared/htmlMeasure.js';

export interface HtmlDraftIssue {
  code: 'text-overflow' | 'missing-asset' | 'blocked-resource' | 'compile-warning';
  blocking: boolean;
  message: string;
  fix: string;
  slideId?: string | null;
  elementId?: string | null;
  beyond?: { x: number; y: number };
}

export interface HtmlDraftWorkflow {
  state: 'blocked' | 'ready-to-apply';
  blockingIssues: HtmlDraftIssue[];
  warnings: HtmlDraftIssue[];
  nextAction: {
    action: 'revise-html' | 'inspect-comparison-once';
    reason: string;
  };
  verificationPolicy: {
    draft: 'one-comparison-view';
    afterApply: 'one-real-player-check';
    stopWhen: string;
  };
}

export interface HtmlDraftWorkflowInput {
  overflows?: TextOverflow[];
  missingAssets?: string[];
  blockedResources?: string[];
  warnings?: string[];
}

/**
 * Turn low-level importer diagnostics into the decision the agent actually
 * needs. This deliberately names an exact fix and stopping condition so a
 * two-pixel overflow cannot send the author into unrelated renderer probes.
 */
export function htmlDraftWorkflow(input: HtmlDraftWorkflowInput): HtmlDraftWorkflow {
  const blockingIssues: HtmlDraftIssue[] = [];
  for (const overflow of input.overflows ?? []) {
    const axis = [overflow.overflowX ? 'horizontal' : '', overflow.overflowY ? 'vertical' : '']
      .filter(Boolean).join(' and ');
    const amount = Math.max(overflow.beyond.x, overflow.beyond.y);
    blockingIssues.push({
      code: 'text-overflow',
      blocking: true,
      slideId: overflow.slideId,
      elementId: overflow.elementId,
      beyond: overflow.beyond,
      message: `${overflow.elementId ?? 'Text'} has ${axis || 'text'} overflow by ${formatPixels(amount)}.`,
      fix: overflow.beyond.y >= overflow.beyond.x
        ? 'Increase this text box height, shorten its text, or opt it into data-autofit="true". Do not debug media rendering.'
        : 'Increase this text box width, shorten its text, or opt it into data-autofit="true". Do not debug media rendering.',
    });
  }
  for (const asset of unique(input.missingAssets)) {
    blockingIssues.push({
      code: 'missing-asset', blocking: true,
      message: `The draft references an unavailable asset: ${asset}`,
      fix: 'Import or upload this asset once, then use the returned deck-relative assets/ path unchanged.',
    });
  }
  for (const resource of unique(input.blockedResources)) {
    if (blockingIssues.some((issue) => issue.code === 'missing-asset' && issue.message.endsWith(resource))) continue;
    blockingIssues.push({
      code: 'blocked-resource', blocking: true,
      message: `Presentation-time external resource was blocked: ${resource}`,
      fix: 'Import the resource once and replace the external URL with the returned deck-relative assets/ path. '
        + 'An image or video the deck already links by https: address may keep that exact address; '
        + 'new linked media is added in the editor (Link…), not through HTML.',
    });
  }
  const warnings = unique(input.warnings).map((warning): HtmlDraftIssue => ({
    code: 'compile-warning', blocking: false, message: warning,
    fix: 'Correct this authored declaration only if it affects the requested design.',
  }));
  const blocked = blockingIssues.length > 0;
  return {
    state: blocked ? 'blocked' : 'ready-to-apply',
    blockingIssues,
    warnings,
    nextAction: blocked
      ? {
        action: 'revise-html',
        reason: `Fix only the ${blockingIssues.length} listed blocking ${blockingIssues.length === 1 ? 'issue' : 'issues'}, then preview the complete draft once more.`,
      }
      : {
        action: 'inspect-comparison-once',
        reason: 'Open the single comparison view once. If it matches the requested design, apply this draft without probing alternate render routes.',
      },
    verificationPolicy: {
      draft: 'one-comparison-view',
      afterApply: 'one-real-player-check',
      stopWhen: 'The apply succeeds and one real-player check shows the requested slide correctly. Stop unless that check reveals a task-relevant defect.',
    },
  };
}

function unique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))];
}

function formatPixels(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}px`;
}
