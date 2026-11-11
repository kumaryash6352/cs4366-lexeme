#include <stdio.h>
#include "list.h"

struct point { int x; int y; };

int main(void) {
  /* Field sensitivity: writing p.x does not reach a read of p.y. */
  struct point p;
  p.x = 1;
  p.y = 2;
  int dx = p.x;

  /* Heap-stored pointers: push() links nodes through n->next and l->head. */
  struct list l = { NULL, 0 };
  push(&l, 3);
  push(&l, 4);
  int total = sum(&l);

  /* Context sensitivity: each call is mapped to its own arguments. */
  int a = 0, b = 0;
  int *pa = pick(&a);
  int *pb = pick(&b);
  *pa = 10;
  int seen_b = b;

  /* Each make_node() call gets its own heap object. */
  struct node *first = make_node(5);
  struct node *second = make_node(6);
  first->value = 7;
  int second_value = second->value;

  printf("%d %d %d %d %d\n", dx, p.y, total, seen_b, second_value);
  return 0;
}
