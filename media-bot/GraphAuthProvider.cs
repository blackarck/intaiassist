using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Microsoft.Graph.Communications.Client.Authentication;
using Microsoft.Identity.Client;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace MediaBot;

/// <summary>
/// Outbound: app-only Graph tokens, minted per customer tenant (multi-tenant bot).
/// Inbound: validates the JWT the Teams calling platform attaches to /callback requests.
/// Pattern follows Microsoft's comms samples (MIT), reworked for current libraries.
/// </summary>
public sealed class GraphAuthProvider : IRequestAuthenticationProvider
{
    private const string TenantClaimLong = "http://schemas.microsoft.com/identity/claims/tenantid";
    private const string OpenIdConfigUrl = "https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration";
    private static readonly string[] Scopes = { "https://graph.microsoft.com/.default" };
    private static readonly string[] ValidIssuers = { "https://graph.microsoft.com", "https://api.botframework.com" };

    private readonly GraphBotOptions _opts;
    private readonly ILogger<GraphAuthProvider> _log;
    private readonly ConcurrentDictionary<string, IConfidentialClientApplication> _msalByTenant = new();
    private readonly ConfigurationManager<OpenIdConnectConfiguration> _oidc =
        new(OpenIdConfigUrl, new OpenIdConnectConfigurationRetriever()) { AutomaticRefreshInterval = TimeSpan.FromHours(2) };

    public GraphAuthProvider(GraphBotOptions opts, ILogger<GraphAuthProvider> log)
    {
        _opts = opts;
        _log = log;
    }

    public async Task AuthenticateOutboundRequestAsync(HttpRequestMessage request, string tenant)
    {
        // No tenant known yet (e.g. first call) -> "common" is not valid for client-credentials; callers must pass one.
        if (string.IsNullOrWhiteSpace(tenant))
            throw new InvalidOperationException("A tenant id is required to get an app-only Graph token for a customer tenant.");

        var app = _msalByTenant.GetOrAdd(tenant, t =>
            ConfidentialClientApplicationBuilder.Create(_opts.AppId)
                .WithAuthority($"https://login.microsoftonline.com/{t}")
                .WithClientSecret(_opts.AppSecret)
                .Build());

        var result = await app.AcquireTokenForClient(Scopes).ExecuteAsync().ConfigureAwait(false);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", result.AccessToken);
    }

    public async Task<RequestValidationResult> ValidateInboundRequestAsync(HttpRequestMessage request)
    {
        var token = request.Headers.Authorization?.Parameter;
        if (string.IsNullOrWhiteSpace(token)) return new RequestValidationResult { IsValid = false };

        try
        {
            var config = await _oidc.GetConfigurationAsync(CancellationToken.None).ConfigureAwait(false);
            var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
            {
                ValidIssuers = ValidIssuers,
                ValidAudience = _opts.AppId,
                IssuerSigningKeys = config.SigningKeys,
                ValidateIssuerSigningKey = true,
                ValidateLifetime = true,
            }).ConfigureAwait(false);

            if (!result.IsValid)
            {
                _log.LogWarning(result.Exception, "inbound callback token rejected");
                return new RequestValidationResult { IsValid = false };
            }

            var tenant = result.ClaimsIdentity.FindFirst("tid")?.Value
                         ?? result.ClaimsIdentity.FindFirst(TenantClaimLong)?.Value;
            if (string.IsNullOrEmpty(tenant)) return new RequestValidationResult { IsValid = false };

            return new RequestValidationResult { IsValid = true, TenantId = tenant };
        }
        catch (Exception e)
        {
            _log.LogError(e, "failed to validate inbound callback token");
            return new RequestValidationResult { IsValid = false };
        }
    }
}
