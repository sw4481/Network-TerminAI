import { useEffect, useState } from "react";

/**
 * Debounces a value by delaying updates until after the specified delay.
 * Useful for optimizing search inputs and preventing excessive API calls.
 *
 * @param value - The value to debounce
 * @param delay - Delay in milliseconds (default: 300ms)
 * @returns The debounced value
 *
 * @example
 * const [searchQuery, setSearchQuery] = useState("");
 * const debouncedQuery = useDebounce(searchQuery, 500);
 *
 * useEffect(() => {
 *   // This will only run 500ms after the user stops typing
 *   performSearch(debouncedQuery);
 * }, [debouncedQuery]);
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    // Set up a timer to update the debounced value after the delay
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    // Clear the timer if value changes before the delay completes
    // This ensures we only update after the user stops changing the value
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}
