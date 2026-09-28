import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UserProfile } from './user.mapper';
import { MailModule } from 'src/mail/mail.module';
import { UserScheduler } from './user.scheduler';
import { Role } from 'src/role/role.entity';
import { Branch } from 'src/branch/branch.entity';
import { UserUtils } from './user.utils';
import { SharedModule } from 'src/shared/shared.module';
import { UserRequirement } from './user-requirement.entity';
import { TransactionManagerService } from 'src/db/transaction-manager.service';
import { BranchUtils } from 'src/branch/branch.utils';
import { ZaloOaConnectorModule } from 'src/zalo-oa-connector/zalo-oa-connector.module';
import { ZaloOaConnectorConfig } from 'src/zalo-oa-connector/entity/zalo-oa-connector.entity';
import { ZaloOaConnectorHistory } from 'src/zalo-oa-connector/entity/zalo-oa-connector-history.entity';
import { BullModule } from '@nestjs/bullmq';
import { QueueRegisterKey } from 'src/app/app.constants';
import { UserBirthdayProducer } from './user-birthday.producer';
import { UserBirthdayConsumer } from './user-birthday.consumer';
import { CampaignModule } from 'src/campaign/campaign.module';
import { SharedUserServiceModule } from 'src/external-services/shared-user-service/shared-user-service.module';
import { UserProvisioningModule } from './user-provisioning.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Role,
      Branch,
      UserRequirement,
      ZaloOaConnectorConfig,
      ZaloOaConnectorHistory,
    ]),
    MailModule,
    SharedModule,
    ZaloOaConnectorModule,
    CampaignModule,
    SharedUserServiceModule,
    // QD19 - UserService (lop 1) va UserScheduler (lop 3) dung chung
    // `ensureLocalUser` voi JwtStrategy (lop 0).
    UserProvisioningModule,
    BullModule.registerQueue({
      name: QueueRegisterKey.USER_BIRTHDAY,
    }),
    BullModule.registerQueue({
      name: QueueRegisterKey.DISTRIBUTE_LOCK_JOB,
    }),
  ],
  controllers: [UserController],
  providers: [
    UserService,
    UserProfile,
    UserScheduler,
    UserUtils,
    TransactionManagerService,
    BranchUtils,
    UserBirthdayProducer,
    UserBirthdayConsumer,
  ],
  exports: [UserService, UserUtils],
})
export class UserModule {}
