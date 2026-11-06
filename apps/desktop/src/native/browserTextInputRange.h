#pragma once
#include <cstddef>

inline bool browserCaretRangeMatches(std::size_t start, std::size_t end,
                                    std::size_t actualStart, std::size_t actualLength) {
  if (start > end || end > 1048576 || actualStart != start) return false;
  // A hidden Chromium view may return either the requested point or its exact
  // native selection range. Wider, partial, or displaced ranges are not evidence.
  return actualLength <= 1 || (end > start && actualLength == end - start);
}
