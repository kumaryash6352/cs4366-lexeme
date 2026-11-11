#ifndef LIST_H
#define LIST_H

struct node {
  int value;
  struct node *next;
};

struct list {
  struct node *head;
  int size;
};

struct node *make_node(int value);
void push(struct list *l, int value);
int sum(const struct list *l);
int *pick(int *p);

#endif
