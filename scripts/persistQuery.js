const https = require('https');
const GraphQLLanguage = require('graphql/language');
const { parse, print } = require('graphql');

require('dotenv').config();

const PERSIST_QUERY_MUTATION = `
  mutation PersistQuery(
    $freeVariables: [String!]!
    $appId: String!
    $accessToken: String
    $query: String!
  ) {
    oneGraph {
      createPersistedQuery(
        input: {
          query: $query
          accessToken: $accessToken
          appId: $appId
          cacheStrategy: { timeToLiveSeconds: 300 }
          freeVariables: $freeVariables
        }
      ) {
        persistedQuery {
          id
        }
      }
    }
  }
`;

async function persistQuery(queryText) {
  const ast = parse(queryText, { noLocation: true });

  const freeVariables = new Set([]);
  let accessToken;
  let transformedAst = GraphQLLanguage.visit(ast, {
    Variable: {
      enter(node) {
        freeVariables.add(node.name.value);
        return node;
      },
    },
    OperationDefinition: {
      enter(node) {
        for (const directive of node.directives) {
          if (directive.name.value === 'persistedQueryConfiguration') {
            const accessTokenArg = directive.arguments.find(
              a => a.name.value === 'accessToken',
            );
            if (accessTokenArg) {
              const envArg = accessTokenArg.value.fields.find(
                f => f.name.value === 'environmentVariable',
              );
              if (envArg) {
                if (accessToken) {
                  throw new Error(
                    'Access token is already defined for operation=' +
                    node.name.value,
                  );
                }
                const envVar = envArg.value.value;
                accessToken = process.env[envVar];
                if (!accessToken) {
                  throw new Error(
                    'Cannot persist query. Missing environment variable `' +
                    envVar +
                    '`.',
                  );
                }
              }
            }
          }
        }
        return {
          ...node,
          directives: node.directives.filter(
            d => d.name.value !== 'persistedQueryConfiguration',
          ),
        };
      },
    },
  });

  const variables = {
    query: print(transformedAst),
    appId: process.env.RAZZLE_ONEGRAPH_APP_ID,
    accessToken: accessToken || null,
    freeVariables: [...freeVariables],
  };

  const body = JSON.stringify({
    query: PERSIST_QUERY_MUTATION,
    variables,
  });
  return new Promise((resolve, reject) => {
    let data = '';
    const req = https.request(
      {
        hostname: 'serve.onegraph.com',
        port: 443,
        path: `/graphql?app_id=${process.env.RAZZLE_ONEGRAPH_APP_ID}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Authorization: 'Bearer ' + process.env.OG_DASHBOARD_ACCESS_TOKEN,
        },
      },
      res => {
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          const resp = JSON.parse(data);
          if (resp.errors) {
            throw new Error(
              'Error persisting query, errors=' + JSON.stringify(resp.errors),
            );
          } else {
            resolve(resp.data.oneGraph.createPersistedQuery.persistedQuery.id);
          }
        });
      },
    );
    req.write(body);
    req.end();
  });
}

exports.default = persistQuery;
