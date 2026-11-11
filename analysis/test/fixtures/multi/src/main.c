#include "counter.h"
#include <string.h>
#include <stdlib.h>

static int helper(int x) { return x * 2; }

int main(void) {
  int n = 0;
  char buf[16];
  int *heap = malloc(sizeof *heap);
  if (!heap) return 1;
  *heap = 3;
  bump(&n);
  bump(heap);
  memset(buf, 0, sizeof buf);
  total = helper(n) + *heap;
  report();
  free(heap);
  return n + buf[0];
}
