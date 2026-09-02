/**
 * TimeStage Component
 *
 * 상영 시간 선택 Stage - ButtonGroup 사용
 */

import { useMemo } from 'react';
import { computeDisplayItems, type TimeItem } from '../../spec';
import { ButtonGroup } from '../components/ButtonGroup';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';

export function TimeStage({
  spec,
  onSelect,
  onNext,
  onBack,
  motionProfile,
  onRevealHidden,
}: StageProps<TimeItem>) {
  const canProceed = !!spec.state.selected;
  const selectedVariant = spec.meta?.selectionRestored === true ? 'visited' : 'active';
  const allItems = useMemo(() => computeDisplayItems(spec, { ignoreFilter: true }), [spec]);
  const visibleIds = useMemo(() => new Set(spec.visibleItems.map((item) => item.id)), [spec.visibleItems]);
  const filteredOutIds = useMemo(
    () => allItems.filter((item) => !visibleIds.has(item.id)).map((item) => item.id),
    [allItems, visibleIds]
  );

  return (
    <div className="flex flex-col items-center gap-6">
      <ButtonGroup
        animationScope={`time-${String(spec.meta?.theaterId ?? '')}-${String(spec.meta?.date ?? '')}`}
        items={spec.visibleItems}
        onSelect={onSelect}
        selectedId={spec.state.selected?.id}
        selectedVariant={selectedVariant}
        highlightedIds={spec.modification.highlight?.itemIds}
        motionProfile={motionProfile}
        onRevealHidden={onRevealHidden}
        allItems={allItems}
        filteredOutIds={filteredOutIds}
        columns="auto"
      />

      <ActionBar
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!canProceed}
      />
    </div>
  );
}
