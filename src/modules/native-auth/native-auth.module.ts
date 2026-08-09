import { Module } from '@nestjs/common';
import { NativeAuthController } from './native-auth.controller';
import { NativeAuthService } from './native-auth.service';

/**
 * OVR-1 native-auth module. DatabaseModule, RedisModule, AuthModule and
 * AuditModule are all @Global, so no imports are needed here; the parent
 * wires this module into AppModule.
 */
@Module({
  controllers: [NativeAuthController],
  providers: [NativeAuthService],
})
export class NativeAuthModule {}
