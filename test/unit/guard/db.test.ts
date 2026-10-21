import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { run, runTable, tool, signedDb, ALLOWLIST, baseInput, type Case } from './helpers';
import { parseServerSpec, matchAllowlist, analyzeDbSegment, findTargetsInText } from '../../../src/guard/db';
import { parseCommand } from '../../../src/guard/parse';
import { evaluate } from '../../../src/guard';

const SQLCMD: Case[] = [
  ['sqlcmd -S sql-test -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q "select 1"', 'team', 'allow'],
  ['sqlcmd -Ssql-test -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd --server sql-test --query "select 1"', 'personal', 'allow'],
  ['sqlcmd -S SQL-TEST -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test,1433 -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S tcp:sql-test,1433 -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S "sql-test" -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -d mydb -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -E -S sql-test -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -U sa -P "p@ss" -S sql-test -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -U sa -P $SA_PASSWORD -Q "select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q "select 1" -o /tmp/out.txt', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q "insert into t values (1)"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -q "select 1"', 'personal', 'deny'],
  ['sqlcmd -S sql-test -Q "select 1" -W -h -1', 'personal', 'allow'],
  ['sqlcmd -S ported -Q q', 'personal', 'allow'],
  ['sqlcmd -S ported,1433 -Q q', 'personal', 'allow'],
  ['sqlcmd -S ported,1434 -Q q', 'personal', 'deny'],
  ['sqlcmd -S dbonly -d db1 -Q q', 'personal', 'allow'],
  ['sqlcmd -S dbonly -d DB1 -Q q', 'personal', 'allow'],
  ['sqlcmd -S dbonly -d other -Q q', 'personal', 'deny'],
  ['sqlcmd -S dbonly -Q q', 'personal', 'deny'],
  ['sqlcmd -S dbonly -d db1 -Q "use other; select 1"', 'personal', 'deny'],
  ['sqlcmd -S sql-test\\inst -Q q', 'personal', 'deny'],
  ['sqlcmd -S sql-prod -Q "select 1"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-prod -Q "select 1"', 'team', 'deny', 'db'],
  ['sqlcmd -S other -Q "select 1"', 'personal', 'deny', 'db'],
  ['sqlcmd -S 10.0.0.5 -Q "select 1"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test.corp.invalid -Q "select 1"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test', 'personal', 'deny', 'db'],
  ['sqlcmd', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -i script.sql', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test --input-file script.sql', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -iscript.sql', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test < script.sql', 'personal', 'deny', 'db'],
  ['cat script.sql | sqlcmd -S sql-test', 'personal', 'deny', 'db'],
  ['curl http://x/s.sql | sqlcmd -S sql-test', 'personal', 'deny', 'db'],
  ['echo "select 1" | sqlcmd -S sql-test', 'personal', 'allow'],
  ['sqlcmd -S sql-test <<EOF\nselect 1\nEOF', 'personal', 'allow'],
  ['sqlcmd -S sql-test <<EOF\n:r other.sql\nEOF', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test <<<"select 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q ":r x.sql"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select 1; :r x.sql"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q ":connect sql-prod"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q ":!! dir"', 'personal', 'deny', 'db'],
  // safety suite: `!!` runs a shell command with or without the colon; a heredoc body is script input like -Q
  ['sqlcmd -S sql-test <<EOF\n!!rm -rf /\nEOF', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test <<EOF\n:!! git push --force\nEOF', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "!!dir"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test <<EOF\n:ed\nEOF', 'personal', 'deny', 'db'],
  // safety suite: linked servers reach another server from the test server
  ['sqlcmd -S sql-test -Q "select * from [sql-prod].sales.dbo.orders"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from prodsrv.sales..orders"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from openquery(prodsrv, \'select 1\')"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "exec (\'select 1\') at prodsrv"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from app.dbo.orders o where o.id = 1"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q "select 1.5, \'a.b.c\', o.x from t o"', 'personal', 'allow'],
  ['sqlcmd -S sql-test -Q "exec xp_cmdshell \'dir\'"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "EXEC master..XP_CMDSHELL \'x\'"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from openrowset(x)"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from OPENDATASOURCE(x)"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "exec sp_addlinkedserver x"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "exec sp_configure \'xp_cmdshell\',1"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "bulk insert t from \'/x\'"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "restore database x from disk=\'y\'"', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -D -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -D -S mydsn -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q q -o ~/.harness/out.txt', 'personal', 'deny', 'protect'],
  ['sqlcmd -S $SERVER -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S "$SERVER" -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S ${SERVER} -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S $(cat server.txt) -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd $ARGS', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test $EXTRA -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q "select * from t where id=$ID"', 'personal', 'allow'],
  ['sqlcmd -Q "select 1"', 'personal', 'allow'],
  ['SQLCMDSERVER=sql-test sqlcmd -Q "select 1"', 'personal', 'allow'],
  ['SQLCMDSERVER=sql-prod sqlcmd -Q "select 1"', 'personal', 'deny', 'db'],
  ['SQLCMDSERVER=other sqlcmd -Q "select 1"', 'personal', 'deny', 'db'],
  ['SQLCMDSERVER=$X sqlcmd -Q "select 1"', 'personal', 'deny', 'db'],
  ['SQLCMDSERVER=sql-test SQLCMDDBNAME=x sqlcmd -Q q', 'personal', 'allow'],
  ['export SQLCMDSERVER=sql-prod', 'personal', 'deny', 'db'],
  ['export SQLCMDSERVER=sql-test', 'personal', 'allow'],
  ['env SQLCMDSERVER=sql-prod sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-test -Q q && sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['sqlcmd -S sql-prod -Q q; echo done', 'personal', 'deny', 'db'],
  ['osql -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['osql -S sql-test -Q q', 'personal', 'allow'],
  ['osql -E -Q q', 'personal', 'allow'],
  ['bcp db.dbo.t in data.csv -S sql-test -T -c', 'personal', 'allow'],
  ['bcp db.dbo.t out data.csv -S sql-prod -T -c', 'personal', 'deny', 'db'],
  ['bcp db.dbo.t in data.csv -T -c', 'personal', 'allow'],
  ['mssql-cli -S sql-test -Q q', 'personal', 'allow'],
  ['mssql-cli -S sql-test', 'personal', 'deny', 'db'],
  ['mssql-cli -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['mssql-cli -S sql-test -i x.sql', 'personal', 'deny', 'db'],
  ['sqlpackage /a:Publish /tsn:sql-test /tdn:x /sf:x.dacpac', 'personal', 'allow'],
  ['sqlpackage /Action:Publish /TargetServerName:sql-test /TargetDatabaseName:x', 'personal', 'allow'],
  ['sqlpackage /a:Publish /tsn:sql-prod /tdn:x', 'personal', 'deny', 'db'],
  ['sqlpackage /a:Publish /TargetServerName:sql-prod', 'personal', 'deny', 'db'],
  ['sqlpackage /a:Publish /tcs:"Server=sql-prod;Database=x"', 'personal', 'deny', 'db'],
  ['sqlpackage /a:Publish /TargetConnectionString:"Data Source=sql-test;Initial Catalog=x"', 'personal', 'allow'],
  ['sqlpackage /a:Export /ssn:sql-test /sdn:x /tf:x.bacpac', 'personal', 'allow'],
  ['sqlpackage /a:Export /ssn:sql-prod', 'personal', 'deny', 'db'],
  ['sqlpackage -a:Publish -tsn:sql-prod', 'personal', 'deny', 'db'],
  ['tsql -H sql-test -p 1433 -U u -P p', 'personal', 'deny', 'db'],
  ['tsql -H sql-prod', 'personal', 'deny', 'db'],
  ['tsql -S prodalias', 'personal', 'deny', 'db'],
];

const PWSH: Case[] = [
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Query q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Database x -Query \'select 1\'"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -Server sql-test -Q q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance:sql-test -Query:q"', 'personal', 'allow'],
  ['pwsh -c "invoke-sqlcmd -serverinstance SQL-TEST -query q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-prod -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance other -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -InputFile x.sql"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ConnectionString \'Server=sql-prod;Database=x\' -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ConnectionString \'Data Source=sql-test;Initial Catalog=x\' -Query q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -Query q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance $s -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Query \':r x.sql\'"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Query \'exec xp_cmdshell x\'"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-DbaQuery -SqlInstance sql-test -Query q"', 'personal', 'allow'],
  ['pwsh -c "Invoke-DbaQuery -SqlInstance sql-prod -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "Invoke-DbaQuery -SqlInstance sql-test -File x.sql"', 'personal', 'deny', 'db'],
  ['pwsh -c "Get-DbaDatabase -SqlInstance sql-test"', 'personal', 'allow'],
  ['pwsh -c "Get-DbaDatabase -SqlInstance sql-prod"', 'personal', 'deny', 'db'],
  ['pwsh -c "Restore-DbaDatabase -SqlInstance sql-prod -Path x"', 'personal', 'deny', 'db'],
  ['powershell -Command "Invoke-Sqlcmd -ServerInstance sql-prod -Query q"', 'personal', 'deny', 'db'],
  ['powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Sqlcmd -ServerInstance sql-prod -Query q"', 'personal', 'deny', 'db'],
  ['pwsh -c "$c = New-Object System.Data.SqlClient.SqlConnection(\'Server=sql-prod;Database=x\'); $c.Open()"', 'personal', 'deny', 'db'],
  ['pwsh -c "$c = New-Object System.Data.SqlClient.SqlConnection(\'Server=sql-test;Database=x\'); $c.Open()"', 'personal', 'allow'],
  ['pwsh -c "[Microsoft.Data.SqlClient.SqlConnection]::new(\'Data Source=sql-prod\')"', 'personal', 'deny', 'db'],
  ['pwsh -c "$c = New-Object System.Data.SqlClient.SqlConnection($cs)"', 'personal', 'deny', 'db'],
  ['pwsh -c "Get-ChildItem"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Query q | Export-Csv out.csv"', 'personal', 'allow'],
  ['pwsh -c "Invoke-Sqlcmd -ServerInstance sql-test -Query q; Invoke-Sqlcmd -ServerInstance sql-prod -Query q"', 'personal', 'deny', 'db'],
];

const OTHER_CLIENTS: Case[] = [
  ['psql -h sql-test -c "select 1"', 'personal', 'allow'],
  ['psql -h sql-test -d db -U u -c "select 1"', 'personal', 'allow'],
  ['psql --host=sql-test --command="select 1"', 'personal', 'allow'],
  ['psql -hsql-test -c q', 'personal', 'allow'],
  ['psql -h sql-prod -c "select 1"', 'personal', 'deny', 'db'],
  ['psql -c "select 1"', 'personal', 'allow'],
  ['PGHOST=sql-prod psql -c q', 'personal', 'deny', 'db'],
  ['PGHOST=sql-test psql -c q', 'personal', 'allow'],
  ['PGSERVICE=prod psql -c q', 'personal', 'deny', 'db'],
  ['psql postgres://u:p@sql-test/db -c q', 'personal', 'allow'],
  ['psql postgresql://u:p@sql-prod:5432/db -c q', 'personal', 'deny', 'db'],
  ['psql "host=sql-test dbname=x" -c q', 'personal', 'allow'],
  ['psql "host=sql-prod dbname=x" -c q', 'personal', 'deny', 'db'],
  ['psql "service=prod" -c q', 'personal', 'deny', 'db'],
  ['psql -d postgres://sql-prod/db -c q', 'personal', 'deny', 'db'],
  ['psql -h sql-test -f x.sql', 'personal', 'deny', 'db'],
  ['psql -h sql-test --file=x.sql', 'personal', 'deny', 'db'],
  ['psql -h sql-test', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\! ls"', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\c other"', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\connect other"', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\i x.sql"', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\copy t from program \'ls\'"', 'personal', 'deny', 'db'],
  ['psql -h sql-test -c "\\\\dt"', 'personal', 'allow'],
  ['psql -h sql-test -l', 'personal', 'allow'],
  ['psql -h sql-test < x.sql', 'personal', 'deny', 'db'],
  ['psql -h sql-test <<EOF\nselect 1\nEOF', 'personal', 'allow'],
  ['echo "select 1" | psql -h sql-test', 'personal', 'allow'],
  ['psql -h sql-test -c q -o ~/.harness/x', 'personal', 'deny', 'protect'],
  ['pg_dump -h sql-test db > dump.sql', 'personal', 'allow'],
  ['pg_dump -h sql-prod db', 'personal', 'deny', 'db'],
  ['pg_restore -h sql-prod -d db x', 'personal', 'deny', 'db'],
  ['pg_restore -h sql-test -d db x', 'personal', 'allow'],
  ['createdb -h sql-prod x', 'personal', 'deny', 'db'],
  ['createdb -h sql-test x', 'personal', 'allow'],
  ['dropdb -h sql-test x', 'personal', 'allow'],
  ['dropdb -h sql-prod x', 'personal', 'deny', 'db'],
  ['pgcli -h sql-test', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "select 1"', 'personal', 'allow'],
  ['mysql -hsql-test -e q', 'personal', 'allow'],
  ['mysql --host=sql-test --execute="select 1"', 'personal', 'allow'],
  ['mysql -u root -psecret -h sql-test -e q', 'personal', 'allow'],
  ['mysql -h sql-test -P 3307 -e q', 'personal', 'allow'],
  ['mysql -h sql-prod -e "select 1"', 'personal', 'deny', 'db'],
  ['mysql -e "select 1"', 'personal', 'allow'],
  ['MYSQL_HOST=sql-prod mysql -e q', 'personal', 'deny', 'db'],
  ['mysql -h sql-test', 'personal', 'deny', 'db'],
  ['mysql -h sql-test < x.sql', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "source x.sql"', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "\\\\. x.sql"', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "system ls"', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "\\\\! ls"', 'personal', 'deny', 'db'],
  ['mysql -h sql-test -e "connect other sql-prod"', 'personal', 'deny', 'db'],
  ['mysql --login-path=prod -e q', 'personal', 'deny', 'db'],
  ['mysql --defaults-file=~/.my.cnf -e q', 'personal', 'deny', 'db'],
  ['mysql --defaults-extra-file=x -e q', 'personal', 'deny', 'db'],
  ['mysqldump -h sql-test db > d.sql', 'personal', 'allow'],
  ['mysqldump -h sql-prod db', 'personal', 'deny', 'db'],
  ['mysqladmin -h sql-prod status', 'personal', 'deny', 'db'],
  ['mariadb -h sql-prod -e q', 'personal', 'deny', 'db'],
  ['mycli -h sql-test', 'personal', 'deny', 'db'],
  ['mongosh --host sql-test --eval "db.x.find()"', 'personal', 'allow'],
  ['mongosh mongodb://sql-prod/db --eval x', 'personal', 'deny', 'db'],
  ['mongosh "mongodb+srv://u:p@sql-prod/db" --eval x', 'personal', 'deny', 'db'],
  ['mongosh --host sql-test', 'personal', 'deny', 'db'],
  ['mongosh --host sql-test --eval "connect(\'mongodb://other\')"', 'personal', 'deny', 'db'],
  ['mongosh --host sql-test -f x.js', 'personal', 'deny', 'db'],
  ['mongo sql-prod:27017/db --eval x', 'personal', 'deny', 'db'],
  ['redis-cli -h sql-test ping', 'personal', 'allow'],
  ['redis-cli -h sql-prod ping', 'personal', 'deny', 'db'],
  ['redis-cli -h sql-test', 'personal', 'deny', 'db'],
  ['redis-cli -u redis://sql-prod:6379 ping', 'personal', 'deny', 'db'],
  ['redis-cli ping', 'personal', 'allow'],
];

const WRAPPERS: Case[] = [
  ['docker exec ctr-db sqlcmd -S localhost -Q q', 'personal', 'allow'],
  ['docker exec ctr-db sqlcmd -S 127.0.0.1 -Q q', 'personal', 'allow'],
  ['docker exec -it ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['docker exec -it ctr-db /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P x -Q q', 'personal', 'allow'],
  ['docker exec -u root -w /tmp ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['docker exec other sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['docker exec other sqlcmd -S localhost -Q q', 'personal', 'deny', 'db'],
  ['docker exec ctr-db sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['docker exec ctr-db sqlcmd -S sql-test -Q q', 'personal', 'allow'],
  ['docker exec ctr-db bash -c "sqlcmd -S localhost -Q q"', 'personal', 'allow'],
  ['docker exec ctr-db bash -c "sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['docker exec ctr-db sh -c "psql -c q"', 'personal', 'allow'],
  ['docker exec -e SQLCMDSERVER=sql-prod ctr-db sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['docker exec --env SQLCMDSERVER=sql-test ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['docker exec ctr-db sqlcmd -S localhost', 'personal', 'deny', 'db'],
  ['docker exec ctr-db sqlcmd -S localhost -i x.sql', 'personal', 'deny', 'db'],
  ['docker container exec ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['docker compose exec ctr-db psql -c q', 'personal', 'allow'],
  ['docker compose exec db psql -c q', 'personal', 'deny', 'db'],
  ['docker-compose exec db sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['docker-compose exec -T ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['podman exec ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['podman exec other sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['docker run --rm mcr.microsoft.com/mssql-tools sqlcmd -S sql-test -Q q', 'personal', 'allow'],
  ['docker run --rm mcr.microsoft.com/mssql-tools sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['docker run --rm -e SQLCMDSERVER=sql-prod mcr.microsoft.com/mssql-tools sqlcmd -Q q', 'personal', 'deny', 'db'],
  ['docker run --rm --name ctr-db -d mcr.microsoft.com/mssql/server:2022-latest', 'personal', 'allow'],
  ['docker run --rm --name other -d mcr.microsoft.com/mssql/server', 'personal', 'deny', 'db'],
  ['docker run --name other -d postgres:16', 'personal', 'deny', 'db'],
  ['docker run -d mysql', 'personal', 'deny', 'db'],
  ['docker run --name ctr-db -d redis', 'personal', 'allow'],
  ['docker run --rm node:20 npm test', 'personal', 'allow'],
  ['docker run --rm -it ubuntu bash', 'personal', 'allow'],
  ['docker run --rm --name ctr-db -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=x -p 1433:1433 mcr.microsoft.com/mssql/server', 'personal', 'allow'],
  ['kubectl exec ctr-db -- sqlcmd -Q q', 'personal', 'allow'],
  ['kubectl exec -it ctr-db -- sqlcmd -S localhost -Q q', 'personal', 'allow'],
  ['kubectl exec -n ns pod/other -- psql -c q', 'personal', 'deny', 'db'],
  ['kubectl exec -n ns deploy/ctr-db -c c -- psql -c q', 'personal', 'allow'],
  ['kubectl exec other -- sqlcmd -S sql-test -Q q', 'personal', 'deny', 'db'],
  ['oc exec other -- psql -c q', 'personal', 'deny', 'db'],
  ['ssh ctr-db sqlcmd -Q q', 'personal', 'allow'],
  ['ssh user@ctr-db "sqlcmd -S localhost -Q q"', 'personal', 'allow'],
  ['ssh other sqlcmd -S sql-test -Q q', 'personal', 'deny', 'db'],
  ['ssh other "psql -c q"', 'personal', 'deny', 'db'],
  ['ssh -p 2222 ctr-db psql -c q', 'personal', 'allow'],
  ['bash -c "sqlcmd -S sql-test -Q q"', 'personal', 'allow'],
  ['bash -c "sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['sh -c \'psql -h sql-prod -c q\'', 'personal', 'deny', 'db'],
  ['bash -lc "export SQLCMDSERVER=sql-prod; sqlcmd -Q q"', 'personal', 'deny', 'db'],
  ['bash -c "cd /tmp && sqlcmd -S sql-test -Q q"', 'personal', 'allow'],
  ['eval "sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['eval sqlcmd -S sql-test -Q q', 'personal', 'allow'],
  ['$(echo sqlcmd) -S sql-prod -Q q', 'personal', 'deny'],
  ['$SQLCMD -S sql-prod -Q q', 'personal', 'deny'],
  ['bash -c "$CMD"', 'personal', 'deny'],
  ['bash -c "sqlcmd $ARGS"', 'personal', 'deny', 'db'],
  ['sh -c "exec sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['nohup sqlcmd -S sql-prod -Q q &', 'personal', 'deny', 'db'],
  ['timeout 30 sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['sudo sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['xargs -a f sqlcmd', 'personal', 'deny', 'db'],
  ['echo "sqlcmd -S sql-prod -Q q" | bash', 'personal', 'deny'],
  ['echo "select 1" | sqlcmd -S sql-prod', 'personal', 'deny', 'db'],
  ['cmd /c sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['cmd /c "sqlcmd -S sql-test -Q \\"select 1\\""', 'personal', 'allow'],
  ['cmd /c "set SQLCMDSERVER=sql-prod & sqlcmd -Q q"', 'personal', 'deny', 'db'],
  ['pwsh -c "sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['pwsh -c "& sqlcmd -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['pwsh -c "& \'C:\\tools\\sqlcmd.exe\' -S sql-prod -Q q"', 'personal', 'deny', 'db'],
  ['pwsh -c "$env:SQLCMDSERVER=\'sql-prod\'; sqlcmd -Q q"', 'personal', 'deny'],
  ['powershell -enc ' + Buffer.from('sqlcmd -S sql-prod -Q q', 'utf16le').toString('base64'), 'personal', 'deny', 'db'],
  ['npx sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['npm exec -- sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['npx -y mssql-cli -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['uv run psql -h sql-prod -c q', 'personal', 'deny', 'db'],
  ['python -m mssql_cli -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['find . -name "*.sql" -exec sqlcmd -S sql-prod -i {} \\;', 'personal', 'deny', 'db'],
  ['tmux send-keys "sqlcmd -S sql-prod -Q q" Enter', 'personal', 'deny', 'db'],
  ['watch -n 5 sqlcmd -S sql-prod -Q q', 'personal', 'deny', 'db'],
  ['ssh -i key.pem other "docker exec ctr-db sqlcmd -Q q"', 'personal', 'allow'],
];

const CODE: Case[] = [
  ['node -e "require(\'mssql\').connect({server:\'sql-test\'})"', 'personal', 'allow'],
  ['node -e "require(\'mssql\').connect({server:\'sql-prod\'})"', 'personal', 'deny', 'db'],
  ['node -e "require(\'mssql\').connect({server:\'sql-prod\',user:\'u\',password:\'Secr3t\'})"', 'personal', 'deny', 'db'],
  ['node -e "const sql=require(\'mssql\');sql.connect(\'Server=sql-prod;Database=x;User Id=u;Password=p\')"', 'personal', 'deny', 'db'],
  ['node -e "const sql=require(\'mssql\');sql.connect(\'Server=sql-test;Database=x\')"', 'personal', 'allow'],
  ['node -e "const sql=require(\'mssql\');sql.connect(\'mssql://u:p@sql-prod/db\')"', 'personal', 'deny', 'db'],
  ['node -e "import(\'tedious\').then(t=>new t.Connection({server:\'sql-prod\'}))"', 'personal', 'deny', 'db'],
  ['node -e "require(\'tedious\')"', 'personal', 'deny', 'db'],
  ['node -e "require(\'mssql\').connect(process.env.DB_CONN)"', 'personal', 'deny', 'db'],
  ['node -e "require(\'pg\').Pool({host:\'sql-test\'})"', 'personal', 'allow'],
  ['node -e "new (require(\'pg\').Client)({host:\'sql-prod\'})"', 'personal', 'deny', 'db'],
  ['node -e "require(\'mysql2\').createConnection({host:`${h}`})"', 'personal', 'deny', 'db'],
  ['node -e "require(\'knex\')({client:\'mssql\',connection:{server:\'sql-prod\'}})"', 'personal', 'deny', 'db'],
  ['node -e "require(\'fs\').readFileSync(\'x\')"', 'personal', 'allow'],
  ['node -e "console.log(1)"', 'personal', 'allow'],
  ['node --eval "require(\'mssql\').connect({server:\'sql-prod\'})"', 'personal', 'deny', 'db'],
  ['node -p "require(\'mssql\').connect({server:\'sql-prod\'})"', 'personal', 'deny', 'db'],
  ['node -r dotenv/config -e "require(\'mssql\').connect({server:\'sql-prod\'})"', 'personal', 'deny', 'db'],
  ['node <<EOF\nrequire("mssql").connect({server:"sql-prod"})\nEOF', 'personal', 'deny', 'db'],
  ['bun -e "import(\'mssql\').then(m=>m.connect({server:\'sql-prod\'}))"', 'personal', 'deny', 'db'],
  ['deno eval "import(\'npm:pg\').then(p=>new p.Client({host:\'sql-prod\'}))"', 'personal', 'deny', 'db'],
  ['python -c "import pyodbc;pyodbc.connect(\'DRIVER={x};SERVER=sql-test;DATABASE=d\')"', 'personal', 'allow'],
  ['python3 -c "import pyodbc; pyodbc.connect(\'Server=sql-prod;Database=x\')"', 'personal', 'deny', 'db'],
  ['python3 -c "import pymssql; pymssql.connect(server=\'sql-prod\')"', 'personal', 'deny', 'db'],
  ['python3 -c "import pymssql; pymssql.connect(server=\'sql-test\', database=\'x\')"', 'personal', 'allow'],
  ['python -c "import psycopg2; psycopg2.connect(host=\'sql-test\')"', 'personal', 'allow'],
  ['python -c "import psycopg2; psycopg2.connect(host=\'sql-prod\')"', 'personal', 'deny', 'db'],
  ['python -c "import psycopg2; psycopg2.connect(os.environ[\'DATABASE_URL\'])"', 'personal', 'deny', 'db'],
  ['python -c "import sqlalchemy; sqlalchemy.create_engine(\'mssql+pyodbc://u:p@sql-prod/db?driver=x\')"', 'personal', 'deny', 'db'],
  ['python -c "import sqlalchemy; sqlalchemy.create_engine(\'postgresql+asyncpg://u:p@sql-test/db\')"', 'personal', 'allow'],
  ['python3 -c "import pyodbc; pyodbc.connect(\'DSN=prod\')"', 'personal', 'deny', 'db'],
  ['python3 -c "from pymongo import MongoClient; MongoClient(\'mongodb://sql-prod\')"', 'personal', 'deny', 'db'],
  ['python -c "print(1)"', 'personal', 'allow'],
  ['python -c "import os; print(os.getcwd())"', 'personal', 'allow'],
  ['python -uc "import pymssql; pymssql.connect(server=\'sql-prod\')"', 'personal', 'deny', 'db'],
  ['python - <<EOF\nimport pymssql\npymssql.connect(server="sql-prod")\nEOF', 'personal', 'deny', 'db'],
  ['python -c "$CODE"', 'personal', 'deny'],
  ['node -e "$CODE"', 'personal', 'deny'],
];

const ENV_PREFIX: Case[] = [
  ['DATABASE_URL=postgres://u:p@sql-test:5432/db npm run migrate', 'personal', 'allow'],
  ['DATABASE_URL=postgres://u:p@sql-prod:5432/db npm run migrate', 'personal', 'deny', 'db'],
  ['DATABASE_URL="postgres://sql-prod/db" npx prisma migrate deploy', 'personal', 'deny', 'db'],
  ['DATABASE_URL=$URL npm run x', 'personal', 'deny', 'db'],
  ['DATABASE_URL=mssql://u:p@sql-test/db npm test', 'personal', 'allow'],
  ['DATABASE_URL="sqlserver://sql-prod:1433;database=x" npm test', 'personal', 'deny', 'db'],
  ['MSSQL_HOST=sql-prod npm test', 'personal', 'deny', 'db'],
  ['MSSQL_HOST=sql-test npm test', 'personal', 'allow'],
  ['MSSQL_SERVER=sql-prod,1433 node app.js', 'personal', 'deny', 'db'],
  ['DB_HOST=sql-prod node app.js', 'personal', 'deny', 'db'],
  ['DB_HOST=sql-test DB_NAME=x node app.js', 'personal', 'allow'],
  ['DB_CONNECTION_STRING="Server=sql-prod;Database=x" dotnet run', 'personal', 'deny', 'db'],
  ['ConnectionStrings__Default="Server=sql-prod" dotnet run', 'personal', 'deny', 'db'],
  ['SQL_CONNECTION="Data Source=sql-test" dotnet run', 'personal', 'allow'],
  ['SQLCMDSERVER=sql-prod npm test', 'personal', 'deny', 'db'],
  ['PGHOST=sql-prod npm test', 'personal', 'deny', 'db'],
  ['PGPASSWORD=x psql -h sql-test -c q', 'personal', 'allow'],
  ['PGPASSWORD=x npm test', 'personal', 'allow'],
  ['DB_PORT=1433 npm test', 'personal', 'allow'],
  ['DB_USER=sa DB_PASSWORD=x npm test', 'personal', 'allow'],
  ['export DATABASE_URL=postgres://sql-prod/x', 'personal', 'deny', 'db'],
  ['export DATABASE_URL=postgres://sql-test/x', 'personal', 'allow'],
  ['export DATABASE_URL="$(cat url.txt)"', 'personal', 'deny', 'db'],
  ['set DATABASE_URL=postgres://sql-prod/x', 'personal', 'deny', 'db'],
  ['NODE_ENV=test npm test', 'personal', 'allow'],
  ['PATH=/x:$PATH npm test', 'personal', 'allow'],
  ['TYPEORM_HOST=sql-prod npm run migration:run', 'personal', 'deny', 'db'],
  ['REDIS_URL=redis://sql-prod:6379 npm start', 'personal', 'deny', 'db'],
  ['MONGODB_URI=mongodb://sql-test/x npm start', 'personal', 'allow'],
];

const MIGRATIONS: Case[] = [
  ['npx prisma migrate deploy', 'personal', 'deny', 'db'],
  ['npx prisma db push', 'personal', 'deny', 'db'],
  ['npx prisma generate', 'personal', 'allow'],
  ['npx prisma format', 'personal', 'allow'],
  ['npx knex migrate:latest', 'personal', 'deny', 'db'],
  ['npx knex migrate:latest --connection postgres://sql-test/x', 'personal', 'allow'],
  ['npx knex migrate:latest --connection postgres://sql-prod/x', 'personal', 'deny', 'db'],
  ['npx knex migrate:make add_x', 'personal', 'allow'],
  ['npx sequelize db:migrate', 'personal', 'deny', 'db'],
  ['npx sequelize db:migrate --url postgres://sql-test/x', 'personal', 'allow'],
  ['npx typeorm migration:run -d src/ds.ts', 'personal', 'deny', 'db'],
  ['npx typeorm migration:generate -d src/ds.ts src/m/X', 'personal', 'allow'],
  ['flyway migrate -url=jdbc:sqlserver://sql-test:1433;databaseName=x', 'personal', 'allow'],
  ['flyway -url=jdbc:sqlserver://sql-prod:1433;databaseName=x migrate', 'personal', 'deny', 'db'],
  ['flyway -url=jdbc:postgresql://sql-test/x clean', 'personal', 'allow'],
  ['flyway info', 'personal', 'deny', 'db'],
  ['liquibase --url=jdbc:sqlserver://sql-prod update', 'personal', 'deny', 'db'],
  ['liquibase --url=jdbc:sqlserver://sql-test update', 'personal', 'allow'],
  ['dotnet ef database update', 'personal', 'deny', 'db'],
  ['dotnet ef database update --connection "Server=sql-test;Database=x"', 'personal', 'allow'],
  ['dotnet ef database update --connection "Server=sql-prod;Database=x"', 'personal', 'deny', 'db'],
  ['dotnet ef migrations add X', 'personal', 'deny', 'db'],
  ['dotnet build', 'personal', 'allow'],
  ['alembic upgrade head', 'personal', 'deny', 'db'],
  ['alembic revision -m x', 'personal', 'deny', 'db'],
  ['alembic history', 'personal', 'allow'],
  ['dbmate -u postgres://sql-test/x up', 'personal', 'allow'],
  ['dbmate -u postgres://sql-prod/x up', 'personal', 'deny', 'db'],
  ['dbmate up', 'personal', 'deny', 'db'],
  ['goose up', 'personal', 'deny', 'db'],
  ['migrate -database postgres://sql-test/x -path m up', 'personal', 'allow'],
  ['migrate -database postgres://sql-prod/x -path m up', 'personal', 'deny', 'db'],
  ['sqitch deploy', 'personal', 'deny', 'db'],
  ['sqitch deploy -t db:pg://sql-test/x', 'personal', 'deny', 'db'],
];

test('sqlcmd family: targets, scripts, interactive sessions, DSNs', () => {
  runTable(SQLCMD);
});
test('PowerShell Invoke-Sqlcmd, dbatools and inline SqlClient', () => {
  runTable(PWSH);
});
test('psql, mysql, mongo and redis clients', () => {
  runTable(OTHER_CLIENTS);
});
test('wrappers: docker, kubectl, ssh, shells, encoded commands', () => {
  runTable(WRAPPERS);
});
test('node and python one-liners using DB modules', () => {
  runTable(CODE);
});
test('env assignments carrying DB targets', () => {
  runTable(ENV_PREFIX);
});
test('migration tools resolve their target from flags or env', () => {
  runTable(MIGRATIONS);
});

test('hook environment supplies the server when the command has none', () => {
  const env = { HOME: '/home/u', SQLCMDSERVER: 'sql-test' };
  assert.equal(run('sqlcmd -Q q', 'personal', { env }).decision, 'allow');
  assert.equal(run('sqlcmd -Q q', 'personal', { env: { HOME: '/home/u', SQLCMDSERVER: 'sql-prod' } }).decision, 'deny');
  assert.equal(run('sqlcmd -Q q', 'personal', { env: { HOME: '/home/u', SQLCMDSERVER: 'other' } }).decision, 'deny');
  assert.equal(run('sqlcmd -S sql-test -Q q', 'personal', { env: { HOME: '/home/u', SQLCMDSERVER: 'sql-prod' } }).decision, 'allow');
  assert.equal(run('psql -c q', 'personal', { env: { HOME: '/home/u', PGHOST: 'sql-prod' } }).decision, 'deny');
  assert.equal(run('psql -c q', 'personal', { env: { HOME: '/home/u', PGHOST: 'sql-test', PGDATABASE: 'x' } }).decision, 'allow');
  assert.equal(run('psql -c q', 'personal', { env: { HOME: '/home/u', PGSERVICE: 'prod' } }).decision, 'deny');
  assert.equal(run('mysql -e q', 'personal', { env: { HOME: '/home/u', MYSQL_HOST: 'sql-prod' } }).decision, 'deny');
  assert.equal(run('npx prisma migrate deploy', 'personal', { env: { HOME: '/home/u', DATABASE_URL: 'postgres://sql-test/x' } }).decision, 'allow');
  assert.equal(run('npx prisma migrate deploy', 'personal', { env: { HOME: '/home/u', DATABASE_URL: 'postgres://sql-prod/x' } }).decision, 'deny');
  assert.equal(run('alembic upgrade head', 'personal', { env: { HOME: '/home/u', DATABASE_URL: 'mssql+pyodbc://u:p@sql-test/x' } }).decision, 'allow');
  assert.equal(run('dotnet ef database update', 'personal', { env: { HOME: '/home/u', ConnectionStrings__DefaultConnection: 'Server=sql-test;Database=x' } }).decision, 'allow');
  assert.equal(run('node -e "require(\'mssql\').connect(process.env.DB_CONN)"', 'personal', { env: { HOME: '/home/u', DB_CONN: 'Server=sql-test;Database=x' } }).decision, 'allow');
  assert.equal(run('node -e "require(\'mssql\').connect(process.env.DB_CONN)"', 'personal', { env: { HOME: '/home/u', DB_CONN: 'Server=sql-prod' } }).decision, 'deny');
  assert.equal(run('python -c "import psycopg2; psycopg2.connect(os.environ[\'DATABASE_URL\'])"', 'personal', { env: { HOME: '/home/u', DATABASE_URL: 'postgres://sql-test/x' } }).decision, 'allow');
  assert.equal(run('sqlcmd -S $DB_HOST -Q q', 'personal', { env: { HOME: '/home/u', DB_HOST: 'sql-test' } }).decision, 'allow');
  assert.equal(run('sqlcmd -S $DB_HOST -Q q', 'personal', { env: { HOME: '/home/u', DB_HOST: 'sql-prod' } }).decision, 'deny');
  assert.equal(run('sqlcmd -S %DB_HOST% -Q q', 'personal', { env: { HOME: '/home/u', DB_HOST: 'sql-test' } }).decision, 'allow');
});

test('empty allowlist denies every DB command and names the marking step', () => {
  const extra = { config: { db: { allowlist: [] }, mcp: { allowedServers: {} } } };
  for (const c of ['sqlcmd -S sql-test -Q q', 'sqlcmd -Q q', 'psql -c q', 'mysql -e q', 'docker exec x sqlcmd -Q q', 'node -e "require(\'mssql\')"', 'DATABASE_URL=postgres://x/y npm test', 'npx prisma migrate deploy']) {
    const r = run(c, 'personal', extra);
    assert.equal(r.decision, 'deny', c);
    assert.equal(r.rail, 'db', c);
    assert.match(r.reason, /harness db mark/, c);
  }
  assert.equal(run('npm test', 'personal', extra).decision, 'allow');
});

test('marked not-test, unsigned and tampered allowlists deny', () => {
  const notTest = { config: { db: signedDb([{ server: 'sql-test', marked: 'not-test' as const }]), mcp: { allowedServers: {} } } };
  const r = run('sqlcmd -S sql-test -Q q', 'personal', notTest);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /not-test/);
  const unsigned = { config: { db: { allowlist: ALLOWLIST }, mcp: { allowedServers: {} } } };
  const u = run('sqlcmd -S sql-test -Q q', 'personal', unsigned);
  assert.equal(u.decision, 'deny');
  assert.match(u.reason, /not signed/);
  const tampered = { config: { db: { allowlist: ALLOWLIST, markedHash: 'deadbeef' }, mcp: { allowedServers: {} } } };
  assert.equal(run('sqlcmd -S sql-test -Q q', 'personal', tampered).decision, 'deny');
  const widened = { config: { db: { allowlist: [...ALLOWLIST, { server: 'sql-prod2', marked: 'test' as const }], markedHash: signedDb().markedHash }, mcp: { allowedServers: {} } } };
  assert.equal(run('sqlcmd -S sql-prod2 -Q q', 'personal', widened).decision, 'deny');
});

test('deny reasons list the test servers and the marking instruction', () => {
  const r = run('sqlcmd -S sql-prod -Q q');
  assert.match(r.reason, /sql-test/);
  assert.match(r.reason, /harness db mark/);
  assert.equal(r.matched, 'sql-prod');
  const i = run('sqlcmd -S sql-test -i x.sql');
  assert.match(i.reason, /-Q/);
  const d = run('sqlcmd -S dbonly -Q q');
  assert.match(d.reason, /db1/);
  const t = run('sqlcmd -S sql-test');
  assert.match(t.reason, /interactive/i);
});

test('MCP tools are denied unless the server is allowlisted and targets match', () => {
  assert.equal(tool('mcp__test-db__query', { server: 'sql-test', sql: 'select 1' }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', { server: 'SQL-TEST' }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', { host: 'ctr-db', port: 1433 }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', { server: 'sql-prod', sql: 'select 1' }).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { server: 'other' }).rail, 'mcp');
  assert.equal(tool('mcp__test-db__query', { connectionString: 'Server=sql-prod;Database=x' }).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { connectionString: 'Server=sql-test;Database=x' }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', { url: 'postgres://sql-test/db' }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', { url: 'postgres://sql-prod/db' }).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { server: '$X' }).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { options: { host: 'sql-prod' } }).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { sql: 'select 1' }).decision, 'allow');
  assert.equal(tool('mcp__test-db__query', {}).decision, 'allow');
  assert.equal(tool('mcp__other__query', {}).decision, 'deny');
  assert.equal(tool('mcp__other__query', {}).rail, 'mcp');
  assert.match(tool('mcp__other__query', {}).reason, /harness config/);
  assert.equal(tool('mcp__any__x', { server: 'whatever' }).decision, 'allow');
  assert.equal(tool('mcp__empty__x', { server: 'sql-test' }).decision, 'deny');
  assert.equal(tool('mcp__empty__x', {}).decision, 'allow');
  assert.equal(tool('mcp__plugin_x_y__tool', {}).decision, 'deny');
  assert.equal(tool('mcp__test-db__query', { server: 'sql-prod' }, 'team').decision, 'deny');
  const noMcp = evaluate({ ...baseInput('personal'), config: { db: signedDb(), mcp: { allowedServers: {} } }, toolName: 'mcp__test-db__query', toolInput: {} });
  assert.equal(noMcp.decision, 'deny');
});

test('server spec parsing and allowlist matching', () => {
  assert.deepEqual(parseServerSpec('tcp:Host,1433'), { host: 'host', port: '1433' });
  assert.deepEqual(parseServerSpec('.'), { host: 'localhost' });
  assert.deepEqual(parseServerSpec('(local)'), { host: 'localhost' });
  assert.deepEqual(parseServerSpec('127.0.0.1'), { host: 'localhost' });
  assert.deepEqual(parseServerSpec('.\\SQLEXPRESS'), { host: 'localhost\\sqlexpress' });
  assert.deepEqual(parseServerSpec('host:5432'), { host: 'host', port: '5432' });
  assert.deepEqual(parseServerSpec('[::1]:5432'), { host: 'localhost', port: '5432' });
  assert.deepEqual(parseServerSpec('np:\\\\host\\pipe\\sql'), { host: 'host' });
  assert.equal(parseServerSpec(''), null);
  assert.equal(parseServerSpec('$X'), null);
  const list = ALLOWLIST;
  assert.ok(matchAllowlist({ host: 'sql-test', source: 'x' }, list).ok);
  assert.ok(matchAllowlist({ host: 'sql-test', port: '1433', source: 'x' }, list).ok);
  assert.ok(matchAllowlist({ host: 'ported', source: 'x' }, list, 'mssql').ok);
  assert.ok(!matchAllowlist({ host: 'ported', port: '1434', source: 'x' }, list).ok);
  assert.equal(matchAllowlist({ host: 'sql-prod', source: 'x' }, list).why, 'not-test');
  assert.equal(matchAllowlist({ host: 'dbonly', source: 'x' }, list).why, 'database');
  assert.ok(matchAllowlist({ host: 'dbonly', database: 'DB1', source: 'x' }, list).ok);
  assert.equal(matchAllowlist({ host: 'nope', source: 'x' }, list).why, 'no-entry');
});

test('text scanning finds URLs, connection strings and env references', () => {
  const f = findTargetsInText('Server=A,1433;Database=D;User=u;Password=p', 'cs', {}, {});
  assert.equal(f.targets[0].host, 'a');
  assert.equal(f.targets[0].port, '1433');
  assert.equal(f.targets[0].database, 'D');
  const u = findTargetsInText('jdbc:sqlserver://h:1433;databaseName=x', 'u', {}, {});
  assert.equal(u.targets[0].host, 'h');
  assert.equal(u.targets[0].database, 'x');
  const d = findTargetsInText('DSN=prod;UID=u', 'c', {}, {});
  assert.ok(d.unresolved.length);
  const e = findTargetsInText('process.env.DATABASE_URL', 'c', {}, { DATABASE_URL: 'postgres://h/x' });
  assert.equal(e.targets[0].host, 'h');
  const m = findTargetsInText('process.env.DATABASE_URL', 'c', {}, {});
  assert.ok(m.unresolved[0].includes('DATABASE_URL'));
  const t = findTargetsInText('mssql://u:p@${HOST}/db', 'c', {}, {});
  assert.ok(t.unresolved.length);
});

test('analyzeDbSegment returns null for non-DB commands', () => {
  const p = parseCommand('npm test');
  assert.equal(analyzeDbSegment(p.segments[0], {}), null);
  const q = parseCommand('sqlcmd -S x -Q q');
  const r = analyzeDbSegment(q.segments[0], {});
  assert.ok(r);
  assert.equal(r!.targets[0].host, 'x');
  assert.equal(r!.interactive, false);
});

test('a command given as an argv array (Codex shell style) is evaluated, never skipped', () => {
  const ev = (tool: string, command: unknown) => evaluate({ ...baseInput('personal'), toolName: tool, toolInput: { command } });
  assert.equal(ev('Bash', ['sqlcmd', '-S', 'sql-prod', '-Q', 'select 1']).decision, 'deny');
  assert.equal(ev('shell', ['bash', '-lc', 'sqlcmd -S sql-prod -Q "select 1"']).decision, 'deny');
  assert.equal(ev('local_shell', ['git', 'push', '--force']).decision, 'deny');
  assert.equal(ev('shell', ['bash', '-lc', 'git push --force origin main']).decision, 'deny');
  assert.equal(ev('shell', ['sqlcmd', '-S', 'sql-test', '-Q', 'select 1']).decision, 'allow');
  assert.equal(ev('shell', ['git', 'status']).decision, 'allow');
  assert.equal(ev('shell', ['bash', '-lc', "echo 'it''s' && ls"]).decision, 'allow');
});
