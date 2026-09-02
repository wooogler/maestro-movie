/**
 * Stage Component Props
 */

import type { UISpec } from '../../spec';

export type GuiMotionProfile = 'default' | 'full-tuning';

export interface StageProps<T = unknown> {
  spec: UISpec<T>;
  onSelect: (id: string) => void;
  onNext: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  motionProfile?: GuiMotionProfile;
  /**
   * The participant reached past a filter to see what it was hiding. Only the
   * three stages that can be filtered pass this through.
   */
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
}
