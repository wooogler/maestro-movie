/**
 * MovieStage Component
 *
 * 영화 선택 Stage - 제목만 표시하는 버튼 목록
 */

import { useMemo } from 'react';
import { computeDisplayItems, type MovieItem } from '../../spec';
import { ButtonGroup } from '../components/ButtonGroup';
import { ActionBar } from './ActionBar';
import type { StageProps } from './types';

export function MovieStage({
  spec,
  onSelect,
  onNext,
  motionProfile,
  onRevealHidden,
}: StageProps<MovieItem>) {
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
        animationScope="movie"
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
        onNext={onNext}
        nextDisabled={!canProceed}
      />
    </div>
  );
}
