import { useState, useCallback } from 'react';

interface UseBlockHoverReturn {
  isHovered: boolean;
  handleMouseEnter: () => void;
  handleMouseLeave: () => void;
}

export function useBlockHover(): UseBlockHoverReturn {
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  return {
    isHovered,
    handleMouseEnter,
    handleMouseLeave,
  };
}
