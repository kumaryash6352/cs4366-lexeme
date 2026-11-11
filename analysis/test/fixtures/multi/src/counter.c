#include "counter.h"
#include <stdio.h>

int total;

static int helper(void) { return total; }

void bump(int *p) {
  *p += 1;
}

void report(void) {
  printf("%d\n", helper());
}
