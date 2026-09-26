import { memo, useCallback, useRef, useState } from 'react';
import { PaneDirection } from '../state/panesStore';
import './PaneHandle.css';

type PaneHandleProps = {
  direction: PaneDirection;
  onResize: (delta: number) => void;
};

export const PaneHandle = memo(function PaneHandle({ direction, onResize }: PaneHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef<number>(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
        const delta = currentPos - startPosRef.current;
        startPosRef.current = currentPos;
        onResize(delta);
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [direction, onResize]
  );

  return (
    <div
      className={`pane-handle pane-handle-${direction} ${isDragging ? 'pane-handle-dragging' : ''}`}
      onMouseDown={handleMouseDown}
    />
  );
});
