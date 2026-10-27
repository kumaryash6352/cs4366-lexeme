import Fastify from 'fastify'

const sampleGraph = `
{
  "functions": [
    {
      "id": "main",
      "name": "main",
      "returnType": "int",
      "parameters": [],
      "entryNodeId": "m1",
      "nodes": [
        { "id": "m1", "type": "statement", "code": "int *a = malloc(sizeof(int));" },
        { "id": "m2", "type": "statement", "code": "int *b = malloc(sizeof(int));" },
        { "id": "m3", "type": "condition", "code": "a == NULL || b == NULL" },
        { "id": "m4", "type": "statement", "code": "free(a);" },
        { "id": "m5", "type": "statement", "code": "free(b);" },
        { "id": "m6", "type": "return", "code": "return 1;" },
        { "id": "m7", "type": "statement", "code": "printf(\"Please enter the value for a: \");" },
        { "id": "m8", "type": "condition", "code": "scanf(\"%d\", a) != 1" },
        { "id": "m9", "type": "statement", "code": "free(a);" },
        { "id": "m10", "type": "statement", "code": "free(b);" },
        { "id": "m11", "type": "return", "code": "return 1;" },
        { "id": "m12", "type": "statement", "code": "printf(\"Please enter the value for b: \");" },
        { "id": "m13", "type": "condition", "code": "scanf(\"%d\", b) != 1" },
        { "id": "m14", "type": "statement", "code": "free(a);" },
        { "id": "m15", "type": "statement", "code": "free(b);" },
        { "id": "m16", "type": "return", "code": "return 1;" },
        { "id": "m17", "type": "statement", "code": "int result = calculate(a, b);" },
        { "id": "m18", "type": "statement", "code": "printf(\"\\nThe result is: %d\\n\", result);" },
        { "id": "m19", "type": "statement", "code": "free(a);" },
        { "id": "m20", "type": "statement", "code": "free(b);" },
        { "id": "m21", "type": "return", "code": "return 0;" }
      ],
      "edges": [
        { "source": "m1", "target": "m2" },
        { "source": "m2", "target": "m3" },
        { "source": "m3", "target": "m4", "branch": true },
        { "source": "m3", "target": "m7", "branch": false },
        { "source": "m4", "target": "m5" },
        { "source": "m5", "target": "m6" },
        { "source": "m7", "target": "m8" },
        { "source": "m8", "target": "m9", "branch": true },
        { "source": "m8", "target": "m12", "branch": false },
        { "source": "m9", "target": "m10" },
        { "source": "m10", "target": "m11" },
        { "source": "m12", "target": "m13" },
        { "source": "m13", "target": "m14", "branch": true },
        { "source": "m13", "target": "m17", "branch": false },
        { "source": "m14", "target": "m15" },
        { "source": "m15", "target": "m16" },
        { "source": "m17", "target": "m18" },
        { "source": "m18", "target": "m19" },
        { "source": "m19", "target": "m20" },
        { "source": "m20", "target": "m21" }
      ]
    },
    {
      "id": "calculate",
      "name": "calculate",
      "returnType": "int",
      "parameters": [
        { "name": "a", "type": "int *" },
        { "name": "b", "type": "int *" }
      ],
      "entryNodeId": "c1",
      "nodes": [
        { "id": "c1", "type": "return", "code": "return *a + *b;" }
      ],
      "edges": []
    }
  ]
}
`

async function analysisRoutes(fastify, options) {
  fastify.route({
    method: 'GET',
    url: '/analyze',
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
            graph: { type: 'string' }
          }
        }
      }
    },
    handler: function (request, reply) {
      reply.send({ graph: sampleGraph })
    }
  })
}

export default analysisRoutes
