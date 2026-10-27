// for loading code from backend
import Fastify from 'fastify'

const sampleCode = `
#include <stdio.h>
#include <stdlib.h>

int calculate(int *a, int *b);

int main(void) {
    int *a = malloc(sizeof(int));
    int *b = malloc(sizeof(int));

    if (a == NULL || b == NULL) {
        free(a);
        free(b);
        return 1;
    }

    printf("Please enter the value for a: ");
    if (scanf("%d", a) != 1) {
        free(a);
        free(b);
        return 1;
    }

    printf("Please enter the value for b: ");
    if (scanf("%d", b) != 1) {
        free(a);
        free(b);
        return 1;
    }

    int result = calculate(a, b);
    printf("\nThe result is: %d\n", result);

    free(a);
    free(b);
    return 0;
}

int calculate(int *a, int *b) {
    return *a + *b;
}
`

async function loaderRoutes(fastify, options) {
  fastify.route({
    method: 'GET',
    url: '/code',
    schema: {
      querystring: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          excitement: { type: 'integer' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            code: { type: 'string' }
          }
        }
      }
    },
    handler: function (request, reply) {
      reply.send({ code: sampleCode })
    }
  })
}

export default loaderRoutes 

