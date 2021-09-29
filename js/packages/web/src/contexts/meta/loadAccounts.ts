import {
  AUCTION_ID,
  METADATA_PROGRAM_ID,
  METAPLEX_ID,
  StringPublicKey,
  toPublicKey,
  VAULT_ID,
} from '@oyster/common/dist/lib/utils/ids';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { AccountAndPubkey, MetaState, ProcessAccountsFunc } from './types';
import { isMetadataPartOfStore } from './isMetadataPartOfStore';
import { processAuctions } from './processAuctions';
import { processMetaplexAccounts } from './processMetaplexAccounts';
import { processMetaData } from './processMetaData';
import { themd } from './metadata.json'
import { processVaultData } from './processVaultData';
import {
  getEdition,
  getMultipleAccounts,
  MAX_CREATOR_LEN,
  MAX_CREATOR_LIMIT,
  MAX_NAME_LENGTH,
  MAX_SYMBOL_LENGTH,
  MAX_URI_LENGTH,
  Metadata,
  METADATA_PREFIX,
  ParsedAccount,
} from '@oyster/common';
import { MAX_WHITELISTED_CREATOR_SIZE } from '../../models/metaplex';

async function getProgramAccounts(
  connection: Connection,
  programId: StringPublicKey,
  configOrCommitment?: any,
): Promise<Array<AccountAndPubkey>> {
  const extra: any = {};
  let commitment;
  //let encoding;

  if (configOrCommitment) {
    if (typeof configOrCommitment === 'string') {
      commitment = configOrCommitment;
    } else {
      commitment = configOrCommitment.commitment;
      //encoding = configOrCommitment.encoding;

      if (configOrCommitment.dataSlice) {
        extra.dataSlice = configOrCommitment.dataSlice;
      }

      if (configOrCommitment.filters) {
        extra.filters = configOrCommitment.filters;
      }
    }
  }

  const args = connection._buildArgs([programId], commitment, 'base64', extra);
  const unsafeRes = await (connection as any)._rpcRequest(
    'getProgramAccounts',
    args,
  );

  const data = (
    unsafeRes.result as Array<{
      account: AccountInfo<[string, string]>;
      pubkey: string;
    }>
  ).map(item => {
    return {
      account: {
        // TODO: possible delay parsing could be added here
        data: Buffer.from(item.account.data[0], 'base64'),
        executable: item.account.executable,
        lamports: item.account.lamports,
        // TODO: maybe we can do it in lazy way? or just use string
        owner: item.account.owner,
      } as AccountInfo<Buffer>,
      pubkey: item.pubkey,
    };
  });

  return data;
}

export const loadAccounts = async (connection: Connection, all: boolean) => {
  const tempCache: MetaState = {
    metadata: themd.metadata,
    metadataByMint: themd.metadataByMint,
    masterEditions: themd.masterEditions,
    masterEditionsByPrintingMint: {},
    masterEditionsByOneTimeAuthMint: {},
    metadataByMasterEdition: themd.metadataByMasterEdition,
    editions: themd.editions,
    auctionManagersByAuction: themd.auctionManagersByAuction,
    bidRedemptions: {},
    auctions: {},
    auctionDataExtended: {},
    vaults:  {},
    payoutTickets: {},
    store: themd.store,
    whitelistedCreatorsByCreator: themd.whitelistedCreatorsByCreator,
    bidderMetadataByAuctionAndBidder: {},
    bidderPotsByAuctionAndBidder: {},
    safetyDepositBoxesByVaultAndIndex: {},
    prizeTrackingTickets: {},
    safetyDepositConfigsByAuctionManagerAndIndex: {},
    bidRedemptionV2sByAuctionManagerAndWinningIndex: {},
    stores: {},
  };
  const updateTemp = makeSetter(tempCache);

  const forEach =
    (fn: ProcessAccountsFunc) => async (accounts: AccountAndPubkey[]) => {
      for (const account of accounts) {
        await fn(account, updateTemp, all);
      }
    };

  const additionalPromises: Promise<void>[] = [];

  const IS_BIG_STORE =
    process.env.NEXT_PUBLIC_BIG_STORE?.toLowerCase() === 'true';
  console.log(`Is big store: ${IS_BIG_STORE}`);

  const promises = [
    getProgramAccounts(connection, VAULT_ID).then(forEach(processVaultData)),
    getProgramAccounts(connection, AUCTION_ID).then(forEach(processAuctions)),
    getProgramAccounts(connection, METAPLEX_ID).then(
      forEach(processMetaplexAccounts),
    ),
    IS_BIG_STORE
      ? getProgramAccounts(connection, METADATA_PROGRAM_ID).then(
          forEach(processMetaData),
        )
      : undefined,
    getProgramAccounts(connection, METAPLEX_ID, {
      filters: [
        {
          dataSize: MAX_WHITELISTED_CREATOR_SIZE,
        },
      ],
    }).then(async creators => {
     
    }),
  ];
  await Promise.all(promises);
  await Promise.all(additionalPromises);

  await postProcessMetadata(tempCache, all);
/*

  for (var obj in tempCache){
    console.log(obj)
    try {
      for (var abc in tempCache[obj]){
          tempCache[obj][abc].account.data = []
      }
    }
    catch(err){}
    console.log(tempCache[obj])
  }
  console.log(tempCache)

*/
  console.log('Metadata size', tempCache.metadata.length);

  if (additionalPromises.length > 0) {
    console.log('Pulling editions for optimized metadata');
    let setOf100MetadataEditionKeys: string[] = [];
    const editionPromises: Promise<{
      keys: string[];
      array: AccountInfo<Buffer>[];
    }>[] = [];

    for (let i = 0; i < tempCache.metadata.length; i++) {
      let edition: StringPublicKey;
      if (tempCache.metadata[i].info.editionNonce != null) {
        edition = (
          await PublicKey.createProgramAddress(
            [
              Buffer.from(METADATA_PREFIX),
              toPublicKey(METADATA_PROGRAM_ID).toBuffer(),
              toPublicKey(tempCache.metadata[i].info.mint).toBuffer(),
              new Uint8Array([tempCache.metadata[i].info.editionNonce || 0]),
            ],
            toPublicKey(METADATA_PROGRAM_ID),
          )
        ).toBase58();
      } else {
        edition = await getEdition(tempCache.metadata[i].info.mint);
      }

      setOf100MetadataEditionKeys.push(edition);

      if (setOf100MetadataEditionKeys.length >= 100) {
        editionPromises.push(
          getMultipleAccounts(
            connection,
            setOf100MetadataEditionKeys,
            'recent',
          ),
        );
        setOf100MetadataEditionKeys = [];
      }
    }

    if (setOf100MetadataEditionKeys.length >= 0) {
      editionPromises.push(
        getMultipleAccounts(connection, setOf100MetadataEditionKeys, 'recent'),
      );
      setOf100MetadataEditionKeys = [];
    }

    const responses = await Promise.all(editionPromises);
    for (let i = 0; i < responses.length; i++) {
      const returnedAccounts = responses[i];
      for (let j = 0; j < returnedAccounts.array.length; j++) {
        processMetaData(
          {
            pubkey: returnedAccounts.keys[j],
            account: returnedAccounts.array[j],
          },
          updateTemp,
          all,
        );
      }
    }
    console.log(
      'Edition size',
      Object.keys(tempCache.editions).length,
      Object.keys(tempCache.masterEditions).length,
    );
  }

  return tempCache;
};

export const makeSetter =
  (state: MetaState) =>
  (prop: keyof MetaState, key: string, value: ParsedAccount<any>) => {
    if (prop === 'store') {
      state[prop] = value;
    } else if (prop !== 'metadata') {
      state[prop][key] = value;
    }
    return state;
  };

const postProcessMetadata = async (tempCache: MetaState, all: boolean) => {
  const values = Object.values(tempCache.metadataByMint);

  for (const metadata of values) {
    await metadataByMintUpdater(metadata, tempCache, all);
  }
};

export const metadataByMintUpdater = async (
  metadata: ParsedAccount<Metadata>,
  state: MetaState,
  all: boolean,
) => {
  const key = metadata.info.mint;
  
    state.metadata.push(metadata);

  return state;
};
