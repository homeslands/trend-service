import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { jwtConstants } from '../../constants';
import { AuthJwtPayload } from '../../auth.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from 'src/user/user.entity';
import { Repository } from 'typeorm';
import { CurrentUserDto } from 'src/user/user.dto';
import { AuthUtils } from '../../auth.utils';
import { SharedUserServiceClient } from 'src/external-services/shared-user-service/shared-user-service.client';
import { UserValidation } from 'src/user/user.validation';
import { UserException } from 'src/user/user.exception';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { UserProvisioningService } from 'src/user/user-provisioning.service';

const RELATIONS = [
  'role.permissions.authority.authorityGroup',
  'branch.addressDetail',
];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly authUtils: AuthUtils,
    private readonly sharedUserServiceClient: SharedUserServiceClient,
    private readonly userProvisioningService: UserProvisioningService,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.publicKey,
      algorithms: [jwtConstants.algorithm],
      usernameField: 'phonenumber',
    });
  }

  async validate(payload: AuthJwtPayload) {
    const context = `${JwtStrategy.name}.${this.validate.name}`;

    // Khoa/mo khoa tai khoan quy het ve shared-user (architect-http.md muc
    // 1.1) - trend khong con giu ban isActive cua rieng no nua (ve sau
    // user_tbl chi con sharedUserId + role + branch), nen MOI request co
    // auth deu phai hoi lai identity that + trang thai khoa qua day, khong
    // dung du lieu cuc bo. Xem issuses/sync-user-data-with-role.md.
    const sharedUser = await this.sharedUserServiceClient
      .lookupById(payload.sub)
      .catch((error) => {
        this.logger.error(
          `Error looking up shared-user by id: ${error.message}`,
          error.stack,
          context,
        );
        throw new ServiceUnavailableException();
      });
    // Token da verify hop le bang public key cua shared-user, nen ve ly
    // thuyet luon tra ve duoc user - null chi xay ra neu tai khoan da bi
    // xoa ben shared-user sau khi token duoc phat hanh.
    if (!sharedUser) throw new UnauthorizedException();
    // Tai khoan bi khoa - chan hoan toan, khong cho request di tiep.
    if (!sharedUser.isActive) throw new UnauthorizedException();

    let user = await this.userRepository.findOne({
      where: {
        sharedUserId: payload.sub,
      },
      relations: RELATIONS,
    });

    if (!user) {
      // Lan dau user nay xuat hien o trend (vd vua tu dang ky ben
      // shared-user, chua ai o trend gan role cho ho) - tu tao row toi
      // gian voi role Customer mac dinh, chan (block) request lai cho toi
      // khi tao xong, khong tra role=null nhu truoc nua. Xem thiet ke +
      // ly do tai issuses/sync-user-data-with-role.md.
      //
      // Day la LOP 0 cua QD19, va dung chung `ensureLocalUser` voi ba lop
      // con lai - khong nhan ban vong insert (xem UserProvisioningService).
      //
      // QD18: neu danh tinh nay thuoc ve mot SERVICE KHAC thi helper nem
      // loi, va o day phai ra 401 - ho la nhan vien cua service khac, theo
      // quy tac nghiep vu khong duoc dung nhu khach o trend.
      try {
        user = await this.userProvisioningService.ensureLocalUser(
          sharedUser,
          RELATIONS,
        );
      } catch (error) {
        // CHI danh tinh cua service khac moi ra 401. Loi ha tang (DB tu
        // choi, role Customer bi xoa) phai giu nguyen ma cua no - quy het
        // ve 401 la bien mot su co he thong thanh "sai tai khoan", va
        // nguoi di dieu tra se tim nham cho.
        if (
          error instanceof UserException &&
          error.errorCodeValue?.code ===
            UserValidation.USER_OWNED_BY_ANOTHER_SERVICE.code
        ) {
          this.logger.warn(
            `Reject login: sharedUserId=${sharedUser.id} belongs to another service`,
            context,
          );
          throw new UnauthorizedException();
        }
        throw error;
      }
    }

    const scope = this.authUtils.buildScope(user);
    return {
      // userId = id CUC BO cua trend (user_tbl.id), KHONG phai payload.sub
      // (id ben shared-user). Moi noi tieu thu CurrentUserDto trong trend
      // deu dung field nay de tra row cuc bo / gan quan he (vd
      // AuthService.getProfile, PaymentService, UserGroupService.create...),
      // nen tra payload.sub vao day se lam moi query cuc bo truot -> loi
      // USER_NOT_FOUND. Muon lay id ben shared-user thi doc user.sharedUserId.
      userId: user.id,
      scope: this.authUtils.parseScope(scope),
    } as CurrentUserDto;
  }
}
