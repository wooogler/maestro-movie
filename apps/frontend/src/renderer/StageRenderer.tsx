/**
 * StageRenderer Component
 *
 * UISpec의 stage에 따라 적절한 Stage 컴포넌트를 렌더링
 */

import type { UISpec, MovieItem, TheaterItem, DateItem, TimeItem, SeatItem } from '../spec';
import {
  MovieStage,
  TheaterStage,
  DateStage,
  TimeStage,
  SeatStage,
  ConfirmStage,
} from './stages';
import type { GuiMotionProfile } from './stages';

export interface StageRendererProps {
  spec: UISpec;
  onSelect: (id: string) => void;
  onToggle?: (id: string) => void;
  onNext: () => void;
  onFinishTask?: () => void;
  onBack?: () => void;
  onConfirm?: () => void;
  motionProfile?: GuiMotionProfile;
  /** Only movie, theater and time can be filtered, so only they report this. */
  onRevealHidden?: (revealed: boolean, hiddenCount: number) => void;
}

export function StageRenderer({
  spec,
  onSelect,
  onToggle,
  onNext,
  onFinishTask,
  onBack,
  onConfirm,
  motionProfile = 'default',
  onRevealHidden,
}: StageRendererProps) {
  switch (spec.stage) {
    case 'movie':
      return (
        <MovieStage
          spec={spec as UISpec<MovieItem>}
          onSelect={onSelect}
          onNext={onNext}
          onRevealHidden={onRevealHidden}
          motionProfile={motionProfile}
        />
      );

    case 'theater':
      return (
        <TheaterStage
          spec={spec as UISpec<TheaterItem>}
          onSelect={onSelect}
          onNext={onNext}
          onRevealHidden={onRevealHidden}
          onBack={onBack}
          motionProfile={motionProfile}
        />
      );

    case 'date':
      return (
        <DateStage
          spec={spec as UISpec<DateItem>}
          onSelect={onSelect}
          onNext={onNext}
          onBack={onBack}
          motionProfile={motionProfile}
        />
      );

    case 'time':
      return (
        <TimeStage
          spec={spec as UISpec<TimeItem>}
          onSelect={onSelect}
          onNext={onNext}
          onRevealHidden={onRevealHidden}
          onBack={onBack}
          motionProfile={motionProfile}
        />
      );

    case 'seat':
      return (
        <SeatStage
          spec={spec as UISpec<SeatItem>}
          onSelect={onSelect}
          onToggle={onToggle ?? onSelect}
          onNext={onNext}
          onBack={onBack}
          motionProfile={motionProfile}
        />
      );

    case 'confirm':
      return (
        <ConfirmStage
          spec={spec}
          onConfirm={onConfirm ?? onNext}
          onNext={onNext}
          onFinishTask={onFinishTask}
          onBack={onBack}
          motionProfile={motionProfile}
        />
      );

    default:
      return <div>Unknown stage: {spec.stage}</div>;
  }
}
