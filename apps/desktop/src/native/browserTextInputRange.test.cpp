#include "browserTextInputRange.h"
#include <cassert>
#include <iostream>

int main() {
  assert(browserCaretRangeMatches(11, 11, 11, 0));
  assert(browserCaretRangeMatches(11, 11, 11, 1));
  assert(browserCaretRangeMatches(0, 20, 0, 20));
  assert(browserCaretRangeMatches(4, 8, 4, 4));
  assert(browserCaretRangeMatches(0, 20, 0, 0));
  assert(!browserCaretRangeMatches(0, 20, 0, 19));
  assert(!browserCaretRangeMatches(0, 20, 1, 19));
  assert(!browserCaretRangeMatches(11, 11, 11, 20));
  assert(!browserCaretRangeMatches(0, 20, 20, 0));
  assert(!browserCaretRangeMatches(8, 4, 8, 0));
  assert(!browserCaretRangeMatches(0, 1048577, 0, 0));
  std::cout << "exact host selection ranges passed\n";
}
