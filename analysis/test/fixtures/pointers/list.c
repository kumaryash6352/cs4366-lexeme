#include <stdlib.h>
#include "list.h"

struct node *make_node(int value) {
  struct node *n = malloc(sizeof *n);
  n->value = value;
  n->next = NULL;
  return n;
}

void push(struct list *l, int value) {
  struct node *n = make_node(value);
  n->next = l->head;
  l->head = n;
  l->size++;
}

int sum(const struct list *l) {
  int total = 0;
  for (struct node *n = l->head; n; n = n->next)
    total += n->value;
  return total;
}

int *pick(int *p) {
  return p;
}
