######### Setup Docker Project Locally ######### 

go to directory where you want to create project and run following commands
export PROJECT_NAME=projectname
mkdir $PROJECT_NAME
cd $PROJECT_NAME
git clone https://github-butbucket-gitlab.com/repo.git src // here you repo url, make sure you copy files into src
cp -r src/docker/* .
bin/start
bin/clinotty mysql -hdb -umagento -pmagento magento < ~/Projects/db/db_dump.sql
bin/composer install
bin/magento s:up 
bin/magento d:m:set  developer // or production
./src/scripts/sync/local-config-update.sh 

