export const KOIOS_URL = process.env.KOIOS_URL ?? 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
export const INDEXER_URL = process.env.INDEXER_URL ?? 'https://mp-indexer.vector.apexfusion.org';
export const REGISTRY_POLICY = 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';
export const REGISTRY_ADDRESS = 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42';
export const ADVERT_ADDRESS = 'addr1wxvjn7jwak9kdvctscywvq0d9f9hksf6ysfa6yatya2efksvgxwpa';
export const ESCROW_ADDRESS = 'addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5';
export const ESCROW_SCRIPT_HASH = '810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912';
export const M3_REPUTATION_ADDRESS = 'addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq';
export const M3_ENDORSEMENT_ADDRESS = 'addr1w9m3j6ld07uy2asssqxvwfqu73ykuqxhjqw7jpulkqera0cjm7mmz';
// Module-1 (dispute) has two deployments on Vector mainnet: v14 (the three unsuffixed labels) and the v15-sim set (script hashes 6c7a075f..., a28a2a36..., 7135ee94...).
// The labels are the keys of the report's dispute section.
export const M1_ADDRESSES = {
  claim: 'addr1wx5ayt5tq8fg905qq7udnclg4a2g42jk78p7gv7qahwcwcqjd9tzq',
  challenge: 'addr1wyf8qr6240wk8j4t8zklk5z9tkj55njtcpqz5jcat2gdr7cazrd0t',
  jury_pool: 'addr1wy4sr34nzeprwatleqhxg7qvv0k0c826wv7wjxdrutn472q7yn6fa',
  claim_v15_sim: 'addr1w9k85p6leg570zlp38ph4rgdflhu90y643xmn349a8e7mqg99t9y5',
  challenge_v15_sim: 'addr1wx3g523kcu09x7mvgzwk9l4glrakyve2k6d9cu50kguj8ac5p5yvr',
  jury_pool_v15_sim: 'addr1w9cntm556kdnk9u4d4jg8ycyrndjn7d5wqm6ez50ttkvregs63695',
} as const;
export const M6_ADDRESSES = {
  proposal: 'addr1wxvtvyx9jkt7jprdhm0g6wxkl8pvvc63vlwumju8f5uatzgnjjjcr',
  critique: 'addr1w9gas5jxfye79d7g87lddu5p3lhvt67ku4ptfvgyqn4rp6stn80z3',
  endorsement: 'addr1w8t3qgtthdpznyaw5vtdh87tlekzg5f5rdcav20ghwf7pms2mfltj',
} as const;
export const didFor = (assetName: string) => `did:vector:agent:${REGISTRY_POLICY}:${assetName}`;
