/**
 * TheaterStage Component
 *
 * 극장 선택 Stage - ButtonGroup 사용
 */

import { useMemo } from 'react';
import { computeDisplayItems, type TheaterItem } from '../../spec';
import { ButtonGroup } from '../components/ButtonGroup';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';

export function TheaterStage({
  spec,
  onSelect,
  onNext,
  onBack,
  motionProfile,
  onRevealHidden,
}: StageProps<TheaterItem>) {
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
        animationScope={`theater-${String(spec.meta?.movieId ?? '')}`}
        items={spec.visibleItems}
        onSelect={onSelect}
        selectedId={spec.state.selected?.id}
        selectedVariant={selectedVariant}
        highlightedIds={spec.modification.highlight?.itemIds}
        motionProfile={motionProfile}
        onRevealHidden={onRevealHidden}
        allItems={allItems}
        filteredOutIds={filteredOutIds}
      />

      <ActionBar
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!canProceed}
      />
    </div>
  );
}
