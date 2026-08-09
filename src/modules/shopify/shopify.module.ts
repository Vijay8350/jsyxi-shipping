import { Module } from '@nestjs/common';
import { TrackPageModule } from '../track-page/track-page.module';
import { EntryTokenService } from './entry-token.service';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { ShopifyOAuthService } from './oauth.service';
import { ShopifyOAuthController } from './oauth.controller';
import { ShopifyEntryService } from './entry.service';
import { ShopifyEntryController } from './entry.controller';
import { ShopifyWebhookDispatcher } from './webhook-dispatcher.service';
import { ShopifyWebhookIngestService } from './webhook-ingest.service';
import { ShopifyWebhookController } from './webhooks.controller';
import { AppSurfaceController } from './app-surface.controller';
import { AppUninstalledHandler } from './handlers/app-uninstalled.handler';

/**
 * Shopify side of §9.1.1–§9.1.5 plus the §8.1 webhook ingest tier.
 * DatabaseModule/RedisModule/AuthModule/AuditModule/ConfigModule are global,
 * so nothing is imported here. The parent wires this module into AppModule.
 *
 * ShopifyGraphqlClient and ShopifyWebhookDispatcher are exported for the
 * order-sync module (§9.2) which reuses the client and registers orders/*
 * topic handlers the same way AppUninstalledHandler does.
 */
@Module({
  imports: [TrackPageModule],
  controllers: [
    ShopifyOAuthController,
    ShopifyEntryController,
    ShopifyWebhookController,
    AppSurfaceController,
  ],
  providers: [
    ShopifyGraphqlClient,
    EntryTokenService,
    ShopifyOAuthService,
    ShopifyEntryService,
    ShopifyWebhookDispatcher,
    ShopifyWebhookIngestService,
    AppUninstalledHandler,
  ],
  exports: [ShopifyGraphqlClient, ShopifyWebhookDispatcher, EntryTokenService],
})
export class ShopifyModule {}
