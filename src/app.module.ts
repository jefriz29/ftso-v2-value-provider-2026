import { Module } from '@nestjs/common';
import { ExampleProviderService } from './app.service';
import { ExampleProviderController } from './app.controller';
import { CcxtFeed } from './data-feeds/ccxt-provider-service';
import { RandomFeed } from './data-feeds/random-feed';
import { BaseDataFeed } from './data-feeds/base-feed';
import { FixedFeed } from './data-feeds/fixed-feed';
import { FtsoFeedV1 } from './data-feeds/ftso-feed-v1';
import { FtsoFeedWebSocket } from './data-feeds/ftso-feed-websocket';

@Module({
  imports: [],
  controllers: [ExampleProviderController],
  providers: [
    {
      provide: 'EXAMPLE_PROVIDER_SERVICE',
      useFactory: async () => {
        let dataFeed: BaseDataFeed;

        if (process.env.VALUE_PROVIDER_IMPL === 'fixed') {
          dataFeed = new FixedFeed();
        } else if (process.env.VALUE_PROVIDER_IMPL === 'random') {
          dataFeed = new RandomFeed();
        } else if (process.env.VALUE_PROVIDER_IMPL === 'ftso-v1') {
          const ftsoFeed = new FtsoFeedV1();
          await ftsoFeed.start();
          dataFeed = ftsoFeed;
        } else if (process.env.VALUE_PROVIDER_IMPL === 'ftso-websocket') {
          const websocketFeed = new FtsoFeedWebSocket();
          await websocketFeed.start();
          dataFeed = websocketFeed;
        } else {
          const ccxtFeed = new CcxtFeed();
          await ccxtFeed.start();
          dataFeed = ccxtFeed;
        }

        return new ExampleProviderService(dataFeed);
      },
    },
  ],
})
export class AppModule {}